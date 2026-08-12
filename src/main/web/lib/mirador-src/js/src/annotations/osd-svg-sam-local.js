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
            this.lastCandidates = null; // 3 mask candidates of the latest decode
            this.maskIndex = 0;         // which candidate is shown/committed
            this.previewMode = 'polygon'; // 'polygon' (P4) | 'bitmap' (pre-P4); P toggles
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

        closeCandidates: function() {
            if (this.lastCandidates) {
                this.lastCandidates.forEach(function(candidate) {
                    if (candidate.maskBitmap) {
                        candidate.maskBitmap.close();
                    }
                });
                this.lastCandidates = null;
            }
        },

        resetOverlayState: function() {
            this.hideStatus();
            this.point_coords = [];   // engine space (fetched-bitmap px)
            this.point_labels = [];
            this.currentKey = null;
            this.lastPolygons = null; // engine space
            this.pendingHover = null;
            this.box = null;
            this.downCss = null;
            this.dragging = false;
            this.maskIndex = 0;
            this.closeCandidates();
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

        /** Engine-space polygons -> closed paper.js paths in project space. */
        createPathsFromPolygons: function(polygons, overlay, entry) {
            var _this = this;
            var viewport = overlay.viewer.viewport;
            overlay.paperScope.project.activeLayer.removeChildren();
            return polygons.map(function(polygon, index) {
                var segments = polygon.map(function(point) {
                    var imagePoint = _this.engineToImage(point, entry);
                    var viewportPoint = viewport.imageToViewportCoordinates(
                        new OpenSeadragon.Point(imagePoint[0], imagePoint[1])
                    );
                    return new overlay.paperScope.Point(viewportPoint.x, viewportPoint.y);
                });
                var shape = new overlay.paperScope.Path({
                    segments: segments,
                    closed: true,
                    dashArray: overlay.dashArray,
                    strokeColor: overlay.strokeColor,
                    name: overlay.getName(_this) + '_' + index,
                });
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
            if (!entry || !this.lastCandidates) {
                return;
            }
            var canvas = this.getPreviewCanvas(overlay);
            var ctx = canvas.getContext('2d');
            var dpr = window.devicePixelRatio || 1;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in css px from here on
            if (this.previewMode === 'bitmap') {
                this.paintMaskBitmap(overlay, entry, ctx);
            } else {
                this.paintMaskPolygons(overlay, entry, ctx);
            }
        },

        /** Pre-P4 preview: the worker's raw 256² binary, stretched to the region. */
        paintMaskBitmap: function(overlay, entry, ctx) {
            var maskBitmap = this.lastCandidates[this.maskIndex].maskBitmap;
            if (!maskBitmap) {
                return;
            }
            var viewport = overlay.viewer.viewport;
            var topLeft = viewport.pixelFromPoint(viewport.imageToViewportCoordinates(
                new OpenSeadragon.Point(entry.region.x, entry.region.y)), true);
            var bottomRight = viewport.pixelFromPoint(viewport.imageToViewportCoordinates(
                new OpenSeadragon.Point(entry.region.x + entry.region.w, entry.region.y + entry.region.h)), true);
            ctx.drawImage(maskBitmap, topLeft.x, topLeft.y,
                bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
        },

        /**
         * P4: preview drawn from the very polygons commit stores, so hovering
         * shows the artefact rather than a different rendering of the same
         * decode. Even-odd fill, so inner rings read as holes as soon as the
         * tracer starts emitting them (P7) with no further change here.
         */
        paintMaskPolygons: function(overlay, entry, ctx) {
            var polygons = this.lastCandidates[this.maskIndex].polygons;
            if (!polygons || !polygons.length) {
                return;
            }
            var _this = this;
            var viewport = overlay.viewer.viewport;
            var path = new Path2D();
            polygons.forEach(function(polygon) {
                polygon.forEach(function(point, index) {
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
            ctx.fillStyle = 'rgba(30, 136, 229, 0.47)';
            ctx.fill(path, 'evenodd');
            // The stroke is the stored outline itself — it is what makes
            // vertex pitch and staircasing legible when zoomed in.
            ctx.strokeStyle = 'rgba(30, 136, 229, 0.95)';
            ctx.lineWidth = 1;
            ctx.stroke(path);
        },

        /**
         * A/B toggle for the preview renderer (P). 'bitmap' is the pre-P4
         * behaviour — the raw 256² binary, showing speckle and holes the stored
         * SVG never contained; 'polygon' draws the committed geometry itself.
         */
        togglePreviewMode: function(overlay) {
            this.previewMode = this.previewMode === 'polygon' ? 'bitmap' : 'polygon';
            this.paintCurrentMask(overlay);
            this.showStatus(
                'Preview: ' + (this.previewMode === 'polygon'
                    ? 'committed polygons (P4, new)'
                    : 'raw mask bitmap (old)')
                    + ' — press P to compare.',
                'info', overlay);
        },

        /** Cycle to the next of the 3 candidate masks (bound to the M key). */
        cycleMask: function(overlay) {
            if (!this.lastCandidates || this.lastCandidates.length < 2) {
                return;
            }
            this.maskIndex = (this.maskIndex + 1) % this.lastCandidates.length;
            this.lastPolygons = this.lastCandidates[this.maskIndex].polygons;
            this.paintCurrentMask(overlay);
            var score = this.lastCandidates[this.maskIndex].score;
            this.showStatus(
                'Mask ' + (this.maskIndex + 1) + '/' + this.lastCandidates.length
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
                if (overlay.currentTool !== _this || !_this.lastCandidates) {
                    return;
                }
                if (keyEvent.key === 'm' || keyEvent.key === 'M') {
                    _this.cycleMask(overlay);
                }
                if (keyEvent.key === 'p' || keyEvent.key === 'P') {
                    _this.togglePreviewMode(overlay);
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
            this.decodeInFlight = engine.decode(this.currentKey, points, labels, this.box || undefined)
                .then(function(result) {
                    _this.closeCandidates();
                    _this.lastCandidates = result.candidates;
                    _this.maskIndex = result.bestIndex;
                    _this.lastPolygons = result.candidates[result.bestIndex].polygons;
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
                var score = this.lastCandidates ? this.lastCandidates[this.maskIndex].score : 0;
                this.showStatus(
                    "Segmentation updated (mask " + (this.maskIndex + 1) + "/3, confidence " + score.toFixed(2) + ").<br>"
                        + "Click to add points (shift = exclude), drag a box, press M to cycle masks.<br>"
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
            if (!this.lastPolygons || !this.lastPolygons.length) {
                this.showStatus("Nothing to save yet — click on the image first.", "warning", overlay);
                return;
            }
            try {
                var entry = this.encodedKeys[this.currentKey];
                overlay.path = this.createPathsFromPolygons(this.lastPolygons, overlay, entry);
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
