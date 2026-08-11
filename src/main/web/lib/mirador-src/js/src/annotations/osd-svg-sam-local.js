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
            logoClass: 'auto_awesome',
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
            this.lastPolygons = null; // engine space
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

        /** css px (offsetX/Y) -> engine px; null when outside the image. */
        cssToEngine: function(overlay, cssX, cssY, entry) {
            var viewport = overlay.viewer.viewport;
            var imagePoint = viewport.viewportToImageCoordinates(
                viewport.pointFromPixel(new OpenSeadragon.Point(cssX, cssY), true)
            );
            var ex = (imagePoint.x - entry.region.x) * (entry.bitmapWidth / entry.region.w);
            var ey = (imagePoint.y - entry.region.y) * (entry.bitmapHeight / entry.region.h);
            if (ex < 0 || ey < 0 || ex > entry.bitmapWidth || ey > entry.bitmapHeight) {
                return null;
            }
            return [ex, ey];
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
            if (this.previewCanvas.width !== size.x || this.previewCanvas.height !== size.y) {
                this.previewCanvas.width = size.x;
                this.previewCanvas.height = size.y;
            }
            return this.previewCanvas;
        },

        clearPreview: function() {
            if (this.previewCanvas && this.previewCanvas.parentNode) {
                this.previewCanvas.parentNode.removeChild(this.previewCanvas);
            }
            this.previewCanvas = null;
        },

        paintMaskPreview: function(overlay, maskBitmap, entry) {
            var viewport = overlay.viewer.viewport;
            var canvas = this.getPreviewCanvas(overlay);
            var ctx = canvas.getContext('2d');
            var topLeft = viewport.pixelFromPoint(viewport.imageToViewportCoordinates(
                new OpenSeadragon.Point(entry.region.x, entry.region.y)), true);
            var bottomRight = viewport.pixelFromPoint(viewport.imageToViewportCoordinates(
                new OpenSeadragon.Point(entry.region.x + entry.region.w, entry.region.y + entry.region.h)), true);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(maskBitmap, topLeft.x, topLeft.y,
                bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
            maskBitmap.close();
        },

        /** Encode the current viewport region unless its embedding is cached. */
        ensureEmbedding: async function(overlay, engine) {
            var region = this.currentRegion(overlay);
            var key = this.regionKey(region);
            this.currentKey = key;
            if (this.encodedKeys[key]) {
                return;
            }
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
            this.encodedKeys[key] = {
                region: region,
                bitmapWidth: bitmap.width,
                bitmapHeight: bitmap.height,
            };
            try {
                await engine.encode(key, bitmap);
            } catch (error) {
                delete this.encodedKeys[key];
                throw error;
            }
        },

        // --- interaction (same grammar as $.Sam) -----------------------------

        onMouseDown: async function(event, overlay) {
            if (event.event.metaKey || event.event.altKey) {
                this.commit(overlay);
                return;
            }
            var hitResult = overlay.paperScope.project.hitTest(event.point, overlay.hitOptions);
            if (hitResult && hitResult.item._name.toString().indexOf(this.idPrefix) !== -1) {
                hitResult.item.fillColor = 'blue';
                return;
            }

            var engine = window.RsSamEngine;
            if (!engine) {
                this.showStatus("In-browser segmentation is not available here.", "error", overlay);
                return;
            }
            if (overlay.mode !== 'create') {
                overlay.mode = 'create';
            }

            var isFirstPoint = this.countShapebyName(overlay, "temp_samlocal_input_point") === 0;
            if (isFirstPoint) {
                this.resetOverlayState();
                try {
                    await this.ensureEmbedding(overlay, engine);
                } catch (error) {
                    this.showStatus("Failed to prepare image: " + error.message, "error", overlay);
                    return;
                }
            }

            var entry = this.encodedKeys[this.currentKey];
            var enginePoint = this.cssToEngine(overlay, event.event.offsetX, event.event.offsetY, entry);
            if (!enginePoint) {
                this.showStatus("Click inside the image.", "warning", overlay);
                return;
            }
            this.point_coords.push(enginePoint);
            this.point_labels.push(event.event.shiftKey ? 0 : 1);
            overlay.path = this.createRefPoint(event, overlay);

            try {
                var result = await engine.decode(this.currentKey, this.point_coords, this.point_labels);
                this.lastPolygons = result.polygons;
                this.paintMaskPreview(overlay, result.maskBitmap, entry);
                this.showStatus(
                    "Segmentation updated.<br>Click to add more positive points or negative points (hold left shift).<br>To save current mask, double-click or hold left alt-key (PC) / command-key (Mac) + click.",
                    "info", overlay);
            } catch (error) {
                this.showStatus("Segmentation failed: " + error.message, "error", overlay);
            }
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

        // --- required no-op tool hooks --------------------------------------
        updateSelection: function(selected, item, overlay) {},
        onResize: function(item, overlay) {},
        onHover: function(activate, shape, hoverWidth, hoverColor) {},
        onMouseUp: function(event, overlay) {},
        onMouseDrag: function(event, overlay) {},
        onMouseMove: function(event, overlay) {}
    };
}(Mirador));
