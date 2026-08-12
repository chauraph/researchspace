/**
 * $.SamLocal — in-browser Segment Anything drawing tool.
 *
 * Same interaction grammar as the server-proxied $.Sam (osd-svg-sam.js):
 * click = positive point, shift+click = negative point, double-click or
 * alt/cmd+click = commit. All inference happens client-side through
 * window.RsSamEngine (a SamClientEngine set up by ImageRegionEditor before
 * Mirador boots; see src/main/web/components/iiif/sam/SamClientEngine.ts and
 * docs/features/sam2-client-side-plan.md).
 *
 * Image capture goes through a same-origin IIIF region request, NOT the OSD
 * drawer canvas: tiles can taint that canvas (the server tool's snapshot
 * branch fails the same way, which is why it grew an IIIF fallback), and a
 * tainted canvas can neither be transferred to the worker nor snapshotted
 * for preview restore. The mask preview therefore also paints onto our own
 * overlay canvas, never the drawer canvas.
 *
 * Coordinate spaces, kept deliberately explicit:
 *  - engine space: pixels of the fetched IIIF region bitmap;
 *  - image space: full-image pixels (region offset + scale away from engine);
 *  - css space: container/mouse space (event.event.offsetX/Y), bridged to
 *    image space via OSD's viewport coordinate API;
 *  - project space: paper.js project coordinates == OSD viewport-normalized
 *    coordinates (the overlay configures paper's view that way), reached from
 *    image space via viewport.imageToViewportCoordinates.
 * The embedding is cached per region key, so several regions drawn in the
 * same view cost one encode.
 */
(function($) {
    /**
     * RDP epsilon as a share of a ring's own perimeter — relative, so a small
     * glyph and a large figure are simplified proportionately instead of the
     * small one being erased.
     *
     * Measured against a rasterised circle of known radius, contoured from the
     * float logits: the raw contour is 481 points at 0.0007px RMS, and this
     * ratio keeps 64 of them at 0.0005px. The previous pipeline — threshold to
     * binary, walk pixel corners, smooth the staircase — stored 286 points at
     * 0.5920px. Nearly all of that error was binarisation, not the model.
     */
    var SIMPLIFY_RATIO = 0.0005;

    $.SamLocal = function(options) {
        jQuery.extend(this, {
            name: 'SamLocal',
            // Ligature must exist in Mirador's own vendored Material Icons font
            // (lib/mirador/fonts/MaterialIcons-Regular.*, a 2016-era cut) — the
            // toolbar renders <i class="material-icons">{{logoClass}}</i> against
            // that @font-face, not the newer npm material-icons package, so
            // post-2016 names like auto_awesome render as raw text.
            logoClass: 'flash_on',
            idPrefix: 'samlocal_',
            tooltip: 'samLocalTooltip',
        }, options);

        this.init();
    };

    $.SamLocal.prototype = {
        init: function() {
            this.statusOverlay = null;
            this.statusTimeout = null;
            this.encodedKeys = {};
            this.keyOrder = [];        // LRU order for encodedKeys
            this.embeddingPromise = null;
            this.decodeInFlight = null;
            this.pendingHover = null;   // latest cursor while a decode is in flight
            this.lastResult = null;     // latest decode: logits + scores + dims
            this.maskIndex = 0;         // which candidate is shown/committed
            // Share of the enclosing ring below which a hole is treated as
            // decoder noise. A user preference, so it deliberately survives
            // resetOverlayState and carries across annotations.
            this.holeAreaRatio = 0.01;
            this.holeMode = 'on'; // 'on' | 'off' (pre-P7 behaviour); H toggles
            // Sub-pixel contours leave no staircase to hide, so rounding is
            // off by default; S dials it in where a painted contour reads
            // better softened.
            this.smoothLevel = 0;
            // SAM's mask_threshold. 0 is the trained value; [ and ] move it,
            // which is the cheapest correction for material the model is not
            // calibrated on (faded ink, hatching, painted edges).
            this.maskThreshold = 0;
            this.polygonCache = null; // memoised visiblePolygons(), see cacheKey()
            this.downCss = null;        // mousedown position, for click-vs-drag
            this.dragging = false;
            this.box = null;            // engine-space [x1,y1,x2,y2] box prompt
            this.viewerHooked = false;
            this.resetOverlayState();
        },

        // --- status pill: same look & lifecycle as $.Sam ---------------------
        initStatusOverlay: function(overlay) {
            if (this.statusOverlay) {
                this.statusOverlay.remove();
                this.statusOverlay = null;
            }
            this.statusOverlay = jQuery('<div>').addClass('mirador-sam-status-overlay')
                .css({
                    'position': 'absolute',
                    'top': '10px',
                    'left': '50%',
                    'transform': 'translateX(-50%)',
                    'padding': '10px 20px',
                    'border-radius': '5px',
                    'z-index': 1000,
                    'color': 'white',
                    'box-shadow': '0 2px 10px rgba(0,0,0,0.2)',
                    'display': 'none',
                    'font-family': 'sans-serif',
                    'font-size': '14px',
                    'max-width': '80%',
                    'text-align': 'center',
                    'pointer-events': 'auto'
                })
                .appendTo(jQuery(overlay.viewer.container));
            return this.statusOverlay;
        },

        showStatus: function(message, type, overlay) {
            if (!this.statusOverlay || !this.statusOverlay.parent().length || this.statusOverlay.parents('body').length === 0) {
                this.initStatusOverlay(overlay);
            }
            if (this.statusTimeout) {
                clearTimeout(this.statusTimeout);
                this.statusTimeout = null;
            }
            const colors = {
                'info': 'rgba(0, 123, 255, 0.8)',
                'warning': 'rgba(255, 193, 7, 0.8)',
                'error': 'rgba(220, 53, 69, 0.8)'
            };
            this.statusOverlay.css('background-color', colors[type] || colors.info);
            this.statusOverlay.html(message
                + '<button style="margin-left: 10px; background: none; border: none; color: white; cursor: pointer; font-size: 20px; line-height: 1; vertical-align: middle;">×</button>'
            );
            this.statusOverlay.find('button').off('click').on('click', () => this.hideStatus());
            this.statusOverlay.fadeIn();
        },

        hideStatus: function() {
            if (this.statusOverlay) {
                this.statusOverlay.fadeOut();
            }
            if (this.statusTimeout) {
                clearTimeout(this.statusTimeout);
                this.statusTimeout = null;
            }
        },

        resetOverlayState: function() {
            this.hideStatus();
            this.point_coords = [];   // engine space (fetched-bitmap px)
            this.point_labels = [];
            this.currentKey = null;
            this.lastResult = null;
            this.lastMaskWidth = null; // decoder mask grid width, for the resolution hint
            this.rawCache = null;
            this.polygonCache = null;
            this.pendingHover = null;
            this.box = null;
            this.downCss = null;
            this.dragging = false;
            this.maskIndex = 0;
            this.clearPreview();
        },

        // --- geometry helpers ------------------------------------------------

        /**
         * The viewport clipped to the image, in image pixels, plus the target
         * fetch width (IIIF "w," size — server preserves aspect).
         */
        currentRegion: function(overlay) {
            var viewport = overlay.viewer.viewport;
            var imageSize = overlay.viewer.world.getItemAt(0).getContentSize();
            var rect = viewport.viewportToImageRectangle(viewport.getBounds(true));
            var x = Math.max(0, Math.floor(rect.x));
            var y = Math.max(0, Math.floor(rect.y));
            var w = Math.min(imageSize.x - x, Math.ceil(rect.width));
            var h = Math.min(imageSize.y - y, Math.ceil(rect.height));
            var fetchWidth = Math.min(w, 1024); // encoder input is 1024² anyway
            return { x: x, y: y, w: w, h: h, fetchWidth: fetchWidth };
        },

        regionKey: function(region) {
            return [region.x, region.y, region.w, region.h, region.fetchWidth].join(':');
        },

        countShapebyName: function(overlay, name) {
            var count = 0;
            overlay.paperScope.project.activeLayer.children.forEach(function(item) {
                if (item.name === name) {
                    count++;
                }
            });
            return count;
        },

        createRefPoint: function(event, overlay) {
            overlay.mode = 'create';
            var shape = new overlay.paperScope.Path.Circle({
                center: event.point,
                radius: 5 / overlay.paperScope.view.zoom,
                fillColor: event.event.shiftKey ? 'blue' : 'red',
                name: "temp_samlocal_input_point"
            });
            shape.data.strokeWidth = overlay.strokeWidth;
            shape.strokeWidth = shape.data.strokeWidth / overlay.paperScope.view.zoom;
            return shape;
        },

        /** engine px -> image px for the region the embedding was made from. */
        engineToImage: function(point, entry) {
            return [
                entry.region.x + point[0] * (entry.region.w / entry.bitmapWidth),
                entry.region.y + point[1] * (entry.region.h / entry.bitmapHeight),
            ];
        },

        /** css px (offsetX/Y) -> engine px, unclamped. */
        cssToEngineRaw: function(overlay, cssX, cssY, entry) {
            var viewport = overlay.viewer.viewport;
            var imagePoint = viewport.viewportToImageCoordinates(
                viewport.pointFromPixel(new OpenSeadragon.Point(cssX, cssY), true)
            );
            return [
                (imagePoint.x - entry.region.x) * (entry.bitmapWidth / entry.region.w),
                (imagePoint.y - entry.region.y) * (entry.bitmapHeight / entry.region.h),
            ];
        },

        /** css px -> engine px; null when outside the image. */
        cssToEngine: function(overlay, cssX, cssY, entry) {
            var point = this.cssToEngineRaw(overlay, cssX, cssY, entry);
            if (point[0] < 0 || point[1] < 0 || point[0] > entry.bitmapWidth || point[1] > entry.bitmapHeight) {
                return null;
            }
            return point;
        },

        /**
         * Engine-space polygons -> closed paper.js paths in project space.
         * A polygon is [outerRing, ...holeRings]; a polygon that has holes
         * becomes one even-odd CompoundPath so the holes punch through rather
         * than being stored as separate filled shapes (P7). Hole-free masks
         * still produce a plain Path, so the common case serializes exactly
         * as it did before.
         */
        createPathsFromPolygons: function(polygons, overlay, entry) {
            var _this = this;
            var viewport = overlay.viewer.viewport;
            overlay.paperScope.project.activeLayer.removeChildren();
            var toSegments = function(ring) {
                return ring.map(function(point) {
                    var imagePoint = _this.engineToImage(point, entry);
                    var viewportPoint = viewport.imageToViewportCoordinates(
                        new OpenSeadragon.Point(imagePoint[0], imagePoint[1])
                    );
                    return new overlay.paperScope.Point(viewportPoint.x, viewportPoint.y);
                });
            };
            return polygons.map(function(rings, index) {
                var name = overlay.getName(_this) + '_' + index;
                var shape;
                if (rings.length > 1) {
                    shape = new overlay.paperScope.CompoundPath({
                        children: rings.map(function(ring) {
                            return new overlay.paperScope.Path({
                                segments: toSegments(ring),
                                closed: true,
                            });
                        }),
                        fillRule: 'evenodd',
                        dashArray: overlay.dashArray,
                        strokeColor: overlay.strokeColor,
                        name: name,
                    });
                } else {
                    shape = new overlay.paperScope.Path({
                        segments: toSegments(rings[0]),
                        closed: true,
                        dashArray: overlay.dashArray,
                        strokeColor: overlay.strokeColor,
                        name: name,
                    });
                }
                shape.data.strokeWidth = overlay.strokeWidth;
                shape.strokeWidth = shape.data.strokeWidth / overlay.paperScope.view.zoom;
                return shape;
            });
        },

        /**
         * Own preview canvas over the viewer (the drawer canvas may be
         * tainted, so it can be neither snapshotted nor restored).
         */
        getPreviewCanvas: function(overlay) {
            var container = overlay.viewer.container;
            var size = overlay.viewer.viewport.getContainerSize();
            if (!this.previewCanvas || !this.previewCanvas.parentNode) {
                this.previewCanvas = document.createElement('canvas');
                this.previewCanvas.className = 'mirador-samlocal-preview';
                this.previewCanvas.style.cssText =
                    'position:absolute;left:0;top:0;pointer-events:none;z-index:50;';
                container.appendChild(this.previewCanvas);
            }
            // Back the canvas at device resolution: at dpr 2 a css-sized canvas
            // halves the effective precision, which is exactly the scale the
            // outline tests are trying to judge.
            var dpr = window.devicePixelRatio || 1;
            var width = Math.round(size.x * dpr);
            var height = Math.round(size.y * dpr);
            if (this.previewCanvas.width !== width || this.previewCanvas.height !== height) {
                this.previewCanvas.width = width;
                this.previewCanvas.height = height;
                this.previewCanvas.style.width = size.x + 'px';
                this.previewCanvas.style.height = size.y + 'px';
            }
            return this.previewCanvas;
        },

        clearPreview: function() {
            if (this.previewCanvas && this.previewCanvas.parentNode) {
                this.previewCanvas.parentNode.removeChild(this.previewCanvas);
            }
            this.previewCanvas = null;
        },

        /** Draw (or redraw, after pan/zoom/cycle) the selected candidate mask. */
        paintCurrentMask: function(overlay) {
            var entry = this.currentKey && this.encodedKeys[this.currentKey];
            if (!entry || !this.lastResult) {
                return;
            }
            var canvas = this.getPreviewCanvas(overlay);
            var ctx = canvas.getContext('2d');
            var dpr = window.devicePixelRatio || 1;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in css px from here on
            this.paintMaskPolygons(overlay, entry, ctx);
        },

        /**
         * P4: preview drawn from the very polygons commit stores, so hovering
         * shows the artefact rather than a different rendering of the same
         * decode. Even-odd fill, so inner rings read as holes as soon as the
         * tracer starts emitting them (P7) with no further change here.
         */
        paintMaskPolygons: function(overlay, entry, ctx) {
            var polygons = this.visiblePolygons();
            if (!polygons || !polygons.length) {
                return;
            }
            var _this = this;
            var viewport = overlay.viewer.viewport;
            var path = new Path2D();
            polygons.forEach(function(rings) {
                rings.forEach(function(ring) {
                    ring.forEach(function(point, index) {
                        var imagePoint = _this.engineToImage(point, entry);
                        var pixel = viewport.pixelFromPoint(viewport.imageToViewportCoordinates(
                            new OpenSeadragon.Point(imagePoint[0], imagePoint[1])), true);
                        if (index === 0) {
                            path.moveTo(pixel.x, pixel.y);
                        } else {
                            path.lineTo(pixel.x, pixel.y);
                        }
                    });
                    path.closePath();
                });
            });
            ctx.fillStyle = 'rgba(30, 136, 229, 0.47)';
            ctx.fill(path, 'evenodd');
            // The stroke is the stored outline itself — it is what makes
            // vertex pitch and staircasing legible when zoomed in.
            ctx.strokeStyle = 'rgba(30, 136, 229, 0.95)';
            ctx.lineWidth = 1;
            ctx.stroke(path);
        },

        /** |shoelace| of a ring, in whatever space its points are given. */
        ringArea: function(ring) {
            var area = 0;
            for (var i = 0; i < ring.length; i++) {
                var j = (i + 1) % ring.length;
                area += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
            }
            return Math.abs(area) / 2;
        },

        /**
         * The current mask's polygons with insignificant holes dropped.
         *
         * The tracer hands over every hole above a bare noise floor; the
         * decision is made here, as a share of the ring that encloses it. An
         * absolute area cannot work: the mask grid is a fixed 256² over
         * whatever region was encoded, so a fixed threshold silently means
         * "hole must be this big *relative to the current zoom*" — the same
         * letter counter fails zoomed out and passes zoomed in. A ratio is
         * scale-free, and because filtering happens here rather than in the
         * worker, the , and . keys move it with no re-decode.
         *
         * Preview and commit both go through this, so what is shown stays
         * what is stored.
         */
        /**
         * Chaikin corner-cutting on a closed ring: each edge is replaced by
         * its quarter and three-quarter points, so every vertex is rounded off
         * and the ring converges towards a quadratic B-spline.
         *
         * This is what removes the staircase. The tracer walks pixel-corner
         * coordinates, so a diagonal edge leaves a run of alternating 1-px
         * steps, which is quantisation of the 256-grid rather than anything
         * the decoder asserted.
         *
         * The win is appearance and payload, not accuracy: measured against a
         * rasterised circle, RMS boundary error only moves 0.616 -> 0.555 px
         * and is flat past two passes. It also rounds genuine corners, which
         * is why S can turn it down on architecture and page edges.
         */
        smoothRing: function(ring, iterations) {
            var points = ring;
            for (var pass = 0; pass < iterations; pass++) {
                if (points.length < 4) {
                    return points;
                }
                var next = [];
                for (var i = 0; i < points.length; i++) {
                    var a = points[i];
                    var b = points[(i + 1) % points.length];
                    next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
                    next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
                }
                points = next;
            }
            return points;
        },

        /**
         * Ramer–Douglas–Peucker on a closed ring, with epsilon taken as a
         * share of the ring's own perimeter rather than an absolute distance.
         * Chaikin quadruples the vertex count per pass and those vertices are
         * stored in the annotation, so this pays them back; scaling by
         * perimeter keeps a small glyph and a large figure equally simplified
         * instead of erasing the small one.
         */
        simplifyRing: function(ring, epsilonRatio) {
            if (ring.length < 8) {
                return ring;
            }
            var perimeter = 0;
            for (var i = 0; i < ring.length; i++) {
                var j = (i + 1) % ring.length;
                perimeter += Math.hypot(ring[j][0] - ring[i][0], ring[j][1] - ring[i][1]);
            }
            var epsilon = perimeter * epsilonRatio;
            var half = Math.floor(ring.length / 2);
            var first = this.rdp(ring.slice(0, half + 1), epsilon);
            var second = this.rdp(ring.slice(half).concat([ring[0]]), epsilon);
            return first.slice(0, -1).concat(second.slice(0, -1));
        },

        rdp: function(points, epsilon) {
            if (points.length < 3) {
                return points;
            }
            var start = points[0], end = points[points.length - 1];
            var maxDistance = 0, index = 0;
            for (var i = 1; i < points.length - 1; i++) {
                var distance = this.pointLineDistance(points[i], start, end);
                if (distance > maxDistance) {
                    maxDistance = distance;
                    index = i;
                }
            }
            if (maxDistance <= epsilon) {
                return [start, end];
            }
            return this.rdp(points.slice(0, index + 1), epsilon)
                .slice(0, -1)
                .concat(this.rdp(points.slice(index), epsilon));
        },

        pointLineDistance: function(p, a, b) {
            var dx = b[0] - a[0], dy = b[1] - a[1];
            var lengthSq = dx * dx + dy * dy;
            if (lengthSq === 0) {
                return Math.hypot(p[0] - a[0], p[1] - a[1]);
            }
            var t = Math.max(0, Math.min(1,
                ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
            return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
        },

        /** Everything that changes the derived geometry, for the memo. */
        cacheKey: function() {
            return [this.maskIndex, this.maskThreshold, this.holeMode,
                this.holeAreaRatio, this.smoothLevel].join('|');
        },

        /**
         * The contour of the selected candidate at the current threshold,
         * straight from the engine and unfiltered — the denominator in the
         * "n of m holes kept" readout.
         */
        rawPolygons: function() {
            if (!this.lastResult || !window.RsSamEngine) {
                return [];
            }
            var key = this.maskIndex + '|' + this.maskThreshold;
            if (this.rawCache && this.rawCache.key === key) {
                return this.rawCache.value;
            }
            var value = window.RsSamEngine.buildPolygons(
                this.lastResult, this.maskIndex, this.maskThreshold);
            this.rawCache = { key: key, value: value };
            return value;
        },

        /** Nudge SAM's mask_threshold ([ and ]) and re-contour. */
        adjustThreshold: function(delta, overlay) {
            this.maskThreshold = Math.min(6, Math.max(-6, this.maskThreshold + delta));
            this.paintCurrentMask(overlay);
            this.showStatus(
                'Mask threshold: ' + this.maskThreshold.toFixed(2)
                    + (this.maskThreshold === 0 ? ' (trained default)' : '')
                    + '<br>[ grows the mask · ] tightens it — no re-decode.',
                'info', overlay);
        },

        visiblePolygons: function() {
            if (!this.lastResult) {
                return [];
            }
            // paintCurrentMask runs on every OSD animation frame, so neither
            // the contouring nor the smoothing may re-run per frame.
            var key = this.cacheKey();
            if (this.polygonCache && this.polygonCache.key === key) {
                return this.polygonCache.value;
            }
            var _this = this;
            var polygons = this.rawPolygons();
            var value = polygons.map(function(rings) {
                var kept;
                if (rings.length < 2 || _this.holeMode === 'off') {
                    kept = [rings[0]];
                } else {
                    var floor = _this.ringArea(rings[0]) * _this.holeAreaRatio;
                    kept = rings.filter(function(ring, index) {
                        return index === 0 || _this.ringArea(ring) >= floor;
                    });
                }
                // Decimation always runs — a sub-pixel contour carries a
                // vertex per grid crossing, far more than the stored shape
                // needs. Rounding is the optional part.
                return kept.map(function(ring) {
                    var shaped = _this.smoothLevel
                        ? _this.smoothRing(ring, _this.smoothLevel)
                        : ring;
                    return _this.simplifyRing(shaped, SIMPLIFY_RATIO);
                });
            });
            this.polygonCache = { key: key, value: value };
            return value;
        },

        /** Cycle outline smoothing off -> light -> medium -> strong (S). */
        cycleSmoothing: function(overlay) {
            this.smoothLevel = (this.smoothLevel + 1) % 4;
            this.paintCurrentMask(overlay);
            var vertices = this.visiblePolygons().reduce(function(sum, rings) {
                return sum + rings.reduce(function(n, ring) { return n + ring.length; }, 0);
            }, 0);
            var names = ['off (raw staircase)', 'light', 'medium', 'strong'];
            this.showStatus(
                'Outline smoothing: ' + names[this.smoothLevel]
                    + ' — ' + vertices + ' points in the shape.'
                    + '<br>S cycles.',
                'info', overlay);
        },

        /** How many holes the tracer actually found, before any filtering. */
        countHoles: function(polygons) {
            return (polygons || []).reduce(function(sum, rings) {
                return sum + Math.max(0, rings.length - 1);
            }, 0);
        },

        /**
         * One status message for every hole control, because the useful thing
         * to see is kept-vs-found. Zero found is a different problem from zero
         * kept: the mask is a fixed 256² grid over whatever region was
         * encoded, so a hole smaller than one mask pixel does not exist in the
         * decoder output and no threshold can bring it back — only encoding a
         * tighter region (zooming in before prompting) can.
         */
        showHoleStatus: function(overlay) {
            var entry = this.currentKey && this.encodedKeys[this.currentKey];
            var found = this.countHoles(this.rawPolygons());
            var kept = this.countHoles(this.visiblePolygons());
            var message = 'Holes: ' + (this.holeMode === 'off' ? 'OFF (H)' : kept + ' of ' + found + ' kept')
                + ' · threshold ' + (this.holeAreaRatio * 100).toFixed(2) + '% of the enclosing shape';
            if (found === 0 && this.holeMode === 'on' && entry && this.lastMaskWidth) {
                var pxPerMaskPx = (entry.region.w / this.lastMaskWidth).toFixed(1);
                message += '<br>The decoder found none: its mask is '
                    + this.lastMaskWidth + '² over a ' + Math.round(entry.region.w)
                    + 'px region (~' + pxPerMaskPx + ' image px per mask px), so anything'
                    + ' smaller than that is not in the output. Zoom in and prompt again.';
            } else {
                message += '<br>, keeps more · . keeps fewer · H toggles holes off';
            }
            this.showStatus(message, 'info', overlay);
        },

        /** Nudge the hole-significance ratio (, and .) and repaint. */
        adjustHoleRatio: function(factor, overlay) {
            var next = this.holeAreaRatio * factor;
            this.holeAreaRatio = Math.min(0.25, Math.max(0.0002, next));
            this.paintCurrentMask(overlay);
            this.showHoleStatus(overlay);
        },

        /** A/B toggle for hole reclamation as a whole (H). */
        toggleHoleMode: function(overlay) {
            this.holeMode = this.holeMode === 'on' ? 'off' : 'on';
            this.paintCurrentMask(overlay);
            this.showHoleStatus(overlay);
        },

        /** Cycle to the next of the 3 candidate masks (bound to the M key). */
        cycleMask: function(overlay) {
            if (!this.lastResult || this.lastResult.maskCount < 2) {
                return;
            }
            this.maskIndex = (this.maskIndex + 1) % this.lastResult.maskCount;
            this.paintCurrentMask(overlay);
            var score = this.lastResult.scores[this.maskIndex];
            this.showStatus(
                'Mask ' + (this.maskIndex + 1) + '/' + this.lastResult.maskCount
                    + ' (confidence ' + score.toFixed(2) + ') — press M to cycle.',
                'info', overlay);
        },

        /** Preview repaint on pan/zoom + the M (cycle) and P (preview A/B) keys. */
        hookViewerEvents: function(overlay) {
            if (this.viewerHooked) {
                return;
            }
            this.viewerHooked = true;
            var _this = this;
            var repaint = function() {
                if (_this.previewCanvas) {
                    _this.paintCurrentMask(overlay);
                }
            };
            overlay.viewer.addHandler('animation', repaint);
            overlay.viewer.addHandler('animation-finish', repaint);
            document.addEventListener('keydown', function(keyEvent) {
                if (overlay.currentTool !== _this || !_this.lastResult) {
                    return;
                }
                if (keyEvent.key === 'm' || keyEvent.key === 'M') {
                    _this.cycleMask(overlay);
                }
                if (keyEvent.key === '[') {
                    _this.adjustThreshold(-0.25, overlay);
                }
                if (keyEvent.key === ']') {
                    _this.adjustThreshold(0.25, overlay);
                }
                if (keyEvent.key === ',' || keyEvent.key === '<') {
                    _this.adjustHoleRatio(1 / 1.6, overlay); // keep smaller holes
                }
                if (keyEvent.key === '.' || keyEvent.key === '>') {
                    _this.adjustHoleRatio(1.6, overlay);     // keep only bigger ones
                }
                if (keyEvent.key === 'h' || keyEvent.key === 'H') {
                    _this.toggleHoleMode(overlay);
                }
                if (keyEvent.key === 's' || keyEvent.key === 'S') {
                    _this.cycleSmoothing(overlay);
                }
            });
        },

        /** Encode the current viewport region unless its embedding is cached. */
        ensureEmbedding: async function(overlay, engine) {
            this.hookViewerEvents(overlay);
            var region = this.currentRegion(overlay);
            var key = this.regionKey(region);
            this.currentKey = key;
            if (this.encodedKeys[key]) {
                return;
            }
            if (this.embeddingPromise) {
                // Another encode is in flight (hover fires often); share it.
                await this.embeddingPromise;
                if (this.encodedKeys[this.currentKey]) {
                    return;
                }
            }
            this.embeddingPromise = this.encodeRegion(overlay, engine, region, key);
            try {
                await this.embeddingPromise;
            } finally {
                this.embeddingPromise = null;
            }
        },

        encodeRegion: async function(overlay, engine, region, key) {
            var _this = this;
            engine.onDownloadProgress = function(progress) {
                var mb = function(n) { return (n / 1048576).toFixed(0); };
                _this.showStatus(
                    'Downloading segmentation model… ' + mb(progress.loaded)
                        + (progress.total ? ' / ' + mb(progress.total) : '') + ' MB'
                        + '<br>(one-time download, cached by your browser)',
                    'info', overlay);
            };
            this.showStatus("Preparing image…", "info", overlay);
            // Same-origin IIIF region request — immune to drawer-canvas taint.
            var imageId = overlay.viewer.world.getItemAt(0).source['@id'];
            var url = imageId + '/' + region.x + ',' + region.y + ',' + region.w + ',' + region.h
                + '/' + region.fetchWidth + ',/0/default.jpg';
            var response = await fetch(url, { credentials: 'same-origin' });
            if (!response.ok) {
                throw new Error('IIIF region request failed (HTTP ' + response.status + ')');
            }
            var bitmap = await createImageBitmap(await response.blob());
            // Capture dimensions before encode() — the bitmap is transferred to
            // the worker and unusable afterwards. Register the cache entry only
            // AFTER the encode succeeds: a concurrent hover that sees a truthy
            // entry will decode against it immediately.
            var entryData = {
                region: region,
                bitmapWidth: bitmap.width,
                bitmapHeight: bitmap.height,
            };
            await engine.encode(key, bitmap);
            this.encodedKeys[key] = entryData;
            // LRU: embeddings are tens of MB of worker-side tensors each.
            this.keyOrder = this.keyOrder.filter(function(k) { return k !== key; });
            this.keyOrder.push(key);
            while (this.keyOrder.length > 3) {
                var evicted = this.keyOrder.shift();
                delete this.encodedKeys[evicted];
                engine.release(evicted);
            }
        },

        /**
         * Coalesced decode+paint: at most one decode in flight. A hover decode
         * arriving while busy replaces pendingHover (only the newest cursor
         * matters); a click decode (hoverPoint == null) queues behind the
         * in-flight one so it is never dropped.
         */
        requestDecode: function(overlay, engine, hoverPoint) {
            var _this = this;
            if (this.decodeInFlight) {
                if (hoverPoint) {
                    this.pendingHover = hoverPoint;
                    return this.decodeInFlight;
                }
                return this.decodeInFlight.then(function() {
                    return _this.requestDecode(overlay, engine, null);
                });
            }
            var entry = this.encodedKeys[this.currentKey];
            if (!entry) {
                return Promise.resolve();
            }
            var points = this.point_coords.slice();
            var labels = this.point_labels.slice();
            if (hoverPoint) {
                points.push(hoverPoint);
                labels.push(1);
            }
            if (!points.length && !this.box) {
                return Promise.resolve();
            }
            // P1: tell the worker which candidate is on screen so a refining
            // prompt can stay on that object instead of re-ranking all three.
            var selectedIndex = this.lastResult ? this.maskIndex : null;
            this.decodeInFlight = engine
                .decode(this.currentKey, points, labels, this.box || undefined, selectedIndex)
                .then(function(result) {
                    _this.lastResult = result;
                    _this.maskIndex = result.bestIndex;
                    _this.lastMaskWidth = result.maskWidth;
                    // New geometry: the memo keys can repeat across decodes.
                    _this.rawCache = null;
                    _this.polygonCache = null;
                    _this.paintCurrentMask(overlay);
                })
                .finally(function() {
                    _this.decodeInFlight = null;
                    if (_this.pendingHover) {
                        var next = _this.pendingHover;
                        _this.pendingHover = null;
                        _this.requestDecode(overlay, engine, next);
                    }
                });
            return this.decodeInFlight;
        },

        // --- interaction ($.Sam's grammar + drag-box + M-to-cycle) -----------

        onMouseDown: function(event, overlay) {
            if (event.event.metaKey || event.event.altKey) {
                this.commit(overlay);
                return;
            }
            var hitResult = overlay.paperScope.project.hitTest(event.point, overlay.hitOptions);
            if (hitResult && hitResult.item._name.toString().indexOf(this.idPrefix) !== -1) {
                hitResult.item.fillColor = 'blue';
                return;
            }
            // Click vs drag is only known at mouseup; just remember the start.
            this.downCss = { x: event.event.offsetX, y: event.event.offsetY };
            this.dragging = false;
        },

        onMouseDrag: function(event, overlay) {
            if (!this.downCss) {
                return;
            }
            this.dragging = true;
            // Rubber-band box in project space while dragging.
            var previous = overlay.paperScope.project.activeLayer.children.filter(function(item) {
                return item.name === 'temp_samlocal_box';
            });
            previous.forEach(function(item) { item.remove(); });
            var shape = new overlay.paperScope.Path.Rectangle({
                from: event.downPoint,
                to: event.point,
                strokeColor: overlay.strokeColor,
                dashArray: [4 / overlay.paperScope.view.zoom, 4 / overlay.paperScope.view.zoom],
                name: 'temp_samlocal_box',
            });
            shape.data.strokeWidth = overlay.strokeWidth;
            shape.strokeWidth = shape.data.strokeWidth / overlay.paperScope.view.zoom;
        },

        onMouseUp: async function(event, overlay) {
            if (!this.downCss) {
                return;
            }
            var downCss = this.downCss;
            var wasDrag = this.dragging;
            this.downCss = null;
            this.dragging = false;

            var engine = window.RsSamEngine;
            if (!engine) {
                this.showStatus("In-browser segmentation is not available here.", "error", overlay);
                return;
            }
            if (overlay.mode !== 'create') {
                overlay.mode = 'create';
            }

            var isFirstPrompt = !this.box && this.point_coords.length === 0;
            if (isFirstPrompt) {
                this.resetOverlayState();
                try {
                    await this.ensureEmbedding(overlay, engine);
                } catch (error) {
                    this.showStatus("Failed to prepare image: " + error.message, "error", overlay);
                    return;
                }
            }

            var entry = this.encodedKeys[this.currentKey];
            if (!entry) {
                try {
                    await this.ensureEmbedding(overlay, engine);
                    entry = this.encodedKeys[this.currentKey];
                } catch (error) {
                    this.showStatus("Failed to prepare image: " + error.message, "error", overlay);
                    return;
                }
            }

            if (wasDrag) {
                // Box prompt: clamp both corners into the encoded bitmap.
                var a = this.cssToEngineRaw(overlay, downCss.x, downCss.y, entry);
                var b = this.cssToEngineRaw(overlay, event.event.offsetX, event.event.offsetY, entry);
                var clamp = function(value, max) { return Math.max(0, Math.min(max, value)); };
                var x1 = clamp(Math.min(a[0], b[0]), entry.bitmapWidth);
                var x2 = clamp(Math.max(a[0], b[0]), entry.bitmapWidth);
                var y1 = clamp(Math.min(a[1], b[1]), entry.bitmapHeight);
                var y2 = clamp(Math.max(a[1], b[1]), entry.bitmapHeight);
                if (x2 - x1 < 2 || y2 - y1 < 2) {
                    this.showStatus("Draw the box over the image.", "warning", overlay);
                    return;
                }
                this.box = [x1, y1, x2, y2];
            } else {
                var enginePoint = this.cssToEngine(overlay, downCss.x, downCss.y, entry);
                if (!enginePoint) {
                    this.showStatus("Click inside the image.", "warning", overlay);
                    return;
                }
                this.point_coords.push(enginePoint);
                this.point_labels.push(event.event.shiftKey ? 0 : 1);
                overlay.path = this.createRefPoint(event, overlay);
            }
            this.pendingHover = null; // the explicit prompt supersedes any queued hover

            try {
                await this.requestDecode(overlay, engine, null);
                var score = this.lastResult ? this.lastResult.scores[this.maskIndex] : 0;
                var count = this.lastResult ? this.lastResult.maskCount : 0;
                var found = this.countHoles(this.rawPolygons());
                this.showStatus(
                    "Segmentation updated (mask " + (this.maskIndex + 1) + "/" + count
                        + ", confidence " + score.toFixed(2) + ", "
                        + this.countHoles(this.visiblePolygons()) + "/" + found + " holes).<br>"
                        + "Click to add points (shift = exclude), drag a box, press M to cycle masks.<br>"
                        + "[ / ] mask threshold · S smoothing · , / . holes · H holes off.<br>"
                        + "Save: double-click, or alt (PC) / cmd (Mac) + click.",
                    "info", overlay);
            } catch (error) {
                this.showStatus("Segmentation failed: " + error.message, "error", overlay);
            }
        },

        /**
         * Hover preview: with the tool armed, moving the mouse shows the mask
         * SAM would produce for a click at the cursor (plus any committed
         * points). The first hover lazily prepares the embedding — including
         * the one-time model download — with progress in the status pill.
         */
        onMouseMove: function(event, overlay) {
            var engine = window.RsSamEngine;
            if (!engine || this.dragging) {
                return;
            }
            var _this = this;
            if (!this.currentKey || !this.encodedKeys[this.currentKey]) {
                if (!this.embeddingPromise) {
                    this.ensureEmbedding(overlay, engine).then(function() {
                        _this.showStatus(
                            "Hover to preview a mask; click to start refining it.",
                            "info", overlay);
                    }).catch(function(error) {
                        _this.showStatus("Failed to prepare image: " + error.message, "error", overlay);
                    });
                }
                return;
            }
            var enginePoint = this.cssToEngine(overlay, event.event.offsetX, event.event.offsetY,
                this.encodedKeys[this.currentKey]);
            if (!enginePoint) {
                return;
            }
            this.requestDecode(overlay, engine, enginePoint).catch(function(error) {
                // Hover decodes fail transiently (e.g. viewport changed mid-flight);
                // click decodes surface their own errors in the status pill.
                console.warn('SamLocal hover decode: ' + error.message);
            });
        },

        onDoubleClick: function(event, overlay) {
            this.commit(overlay);
        },

        commit: function(overlay) {
            if (overlay.mode !== 'create') {
                return;
            }
            if (!this.lastResult || !this.visiblePolygons().length) {
                this.showStatus("Nothing to save yet — click on the image first.", "warning", overlay);
                return;
            }
            try {
                var entry = this.encodedKeys[this.currentKey];
                // The same call the preview uses, so commit stores exactly
                // the geometry that is on screen at the current settings.
                overlay.path = this.createPathsFromPolygons(this.visiblePolygons(), overlay, entry);
                overlay.onDrawFinish();
                this.clearPreview();
                overlay.mode = '';
                this.showStatus("Segmentation complete!", "info", overlay);
                var _this = this;
                this.statusTimeout = setTimeout(function() {
                    _this.hideStatus();
                    _this.resetOverlayState();
                }, 2000);
            } catch (error) {
                this.showStatus("Failed to finalize segmentation: " + error.message, "error", overlay);
            }
        },

        // --- required no-op tool hooks (mouse hooks are implemented above) ---
        updateSelection: function(selected, item, overlay) {},
        onResize: function(item, overlay) {},
        onHover: function(activate, shape, hoverWidth, hoverColor) {}
    };
}(Mirador));
