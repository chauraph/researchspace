/**
 * $.SamLocal — in-browser Segment Anything drawing tool.
 *
 * Interaction: hover previews a mask, the first click LOCKS it (hover stops
 * re-segmenting), further clicks refine it, and an explicit Accept stores it.
 * Include/exclude is a control on the panel with shift as a momentary flip.
 *
 * Deliberately no longer $.Sam's grammar. Double-click-to-commit is gone:
 * the overlay recognises a double-click on the second mousedown (see
 * osd-svg-overlay.js), by which point the first click's mouseup has already
 * added a positive point and re-decoded — so the mask that got saved was
 * never the mask the user was looking at when they decided to save it.
 * alt/cmd+click survives as an accelerator, alongside Enter.
 *
 * All inference happens client-side through window.RsSamEngine (a
 * SamClientEngine set up by ImageRegionEditor before Mirador boots; see
 * src/main/web/components/iiif/sam/SamClientEngine.ts and
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
            // Sticky include/exclude, so carving several voids out of one
            // figure does not mean holding a modifier for a dozen clicks.
            this.polarity = 'pos';      // 'pos' | 'neg'
            this.shiftHeld = false;     // momentary flip; XORs with polarity
            this.panel = null;
            this.ui = {};
            this.resetOverlayState();
        },

        /** The polarity of the click about to be made. */
        negativeNow: function(shiftKey) {
            var shift = shiftKey === undefined ? this.shiftHeld : !!shiftKey;
            return (this.polarity === 'neg') !== shift;
        },

        // --- control panel ----------------------------------------------------
        //
        // Every knob used to be a bare keystroke announced once in a status
        // pill that then faded, which meant the only way to know the tool had
        // a threshold was to have been told. The keys all survive as
        // accelerators; this is the surface that makes them discoverable, and
        // the readouts (candidate, confidence, point count, holes kept of
        // found) are the ones needed to judge a mask before storing it.

        ensureStyles: function() {
            if (document.getElementById('rs-samlocal-styles')) {
                return;
            }
            var css = [
                '.rs-sam-panel{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);',
                'width:min(640px,calc(100% - 28px));background:#161e27;border:1px solid #2b3746;',
                'border-radius:5px;box-shadow:0 14px 40px rgba(0,0,0,.5);color:#eaeff4;',
                'padding:11px 13px 12px;display:flex;flex-direction:column;gap:9px;z-index:1001;',
                'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:13px;line-height:1.4;}',
                '.rs-sam-panel[hidden]{display:none;}',
                '.rs-sam-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
                '.rs-sam-state{display:inline-flex;align-items:center;gap:7px;font-weight:600;}',
                '.rs-sam-state i{width:7px;height:7px;border-radius:50%;background:#97a6b5;display:inline-block;}',
                '.rs-sam-panel.is-locked .rs-sam-state i{background:#4d9dee;}',
                '.rs-sam-tally{margin-left:auto;display:flex;gap:10px;font-size:12px;color:#97a6b5;',
                'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;}',
                '.rs-sam-tally span{display:inline-flex;align-items:center;gap:5px;}',
                '.rs-sam-tally i{width:8px;height:8px;border-radius:50%;display:inline-block;}',
                '.rs-sam-tally .rs-p i{background:#3fc07d;}.rs-sam-tally .rs-n i{background:#ef5f63;}',
                '.rs-sam-rows{display:flex;flex-direction:column;gap:7px;}',
                '.rs-sam-row{display:flex;align-items:center;gap:9px;min-height:26px;}',
                '.rs-sam-lbl{flex:0 0 66px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;',
                'font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:#97a6b5;}',
                '.rs-sam-val{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;',
                'font-variant-numeric:tabular-nums;min-width:52px;}',
                '.rs-sam-val.rs-dim{color:#97a6b5;}',
                '.rs-sam-panel kbd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;',
                'line-height:1;padding:3px 5px;border:1px solid #2b3746;border-bottom-width:2px;',
                'border-radius:3px;color:#97a6b5;background:rgba(255,255,255,.035);white-space:nowrap;}',
                '.rs-sam-panel kbd.is-held{border-color:#ef5f63;color:#eaeff4;background:rgba(239,95,99,.22);}',
                '.rs-sam-panel input[type=range]{flex:1 1 auto;min-width:80px;accent-color:#4d9dee;height:18px;}',
                '.rs-sam-seg{display:inline-flex;border:1px solid #2b3746;border-radius:3px;overflow:hidden;}',
                '.rs-sam-seg button{background:none;border:0;color:#97a6b5;font:500 11.5px/1 inherit;',
                'padding:6px 9px;cursor:pointer;}',
                '.rs-sam-seg button + button{border-left:1px solid #2b3746;}',
                '.rs-sam-seg button[aria-pressed=true]{background:#1e88e5;color:#fff;}',
                '.rs-sam-seg i{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px;vertical-align:-1px;}',
                '.rs-sam-seg .rs-pos{background:#3fc07d;}.rs-sam-seg .rs-neg{background:#ef5f63;}',
                '.rs-sam-seg button[aria-pressed=true] i{background:#fff;}',
                '.rs-sam-polarity.is-flipped{box-shadow:0 0 0 2px #ef5f63;}',
                '.rs-sam-polarity.is-flipped button[data-pol=neg]{background:#ef5f63;color:#fff;}',
                '.rs-sam-polarity.is-flipped button[data-pol=neg] i{background:#fff;}',
                '.rs-sam-polarity.is-flipped button[data-pol=pos]{background:none;color:#97a6b5;}',
                '.rs-sam-polarity.is-flipped button[data-pol=pos] i{background:#3fc07d;}',
                '.rs-sam-cyc{display:inline-flex;align-items:center;gap:6px;}',
                '.rs-sam-cyc button{width:24px;height:24px;background:none;border:1px solid #2b3746;',
                'color:#eaeff4;font-size:13px;line-height:1;cursor:pointer;border-radius:3px;}',
                '.rs-sam-actions{display:flex;align-items:center;gap:8px;padding-top:8px;border-top:1px solid #2b3746;}',
                '.rs-sam-actions .rs-spacer{flex:1;}',
                '.rs-sam-mini{background:none;border:1px solid #2b3746;color:#97a6b5;font:inherit;',
                'font-size:12px;padding:6px 9px;cursor:pointer;border-radius:3px;}',
                '.rs-sam-ghost{background:none;border:1px solid #2b3746;color:#eaeff4;font:inherit;',
                'font-size:13px;padding:7px 13px;cursor:pointer;border-radius:3px;}',
                '.rs-sam-primary{background:#1e88e5;border:1px solid #1e88e5;color:#fff;font:inherit;',
                'font-size:13px;font-weight:600;padding:7px 15px;cursor:pointer;border-radius:3px;',
                'display:inline-flex;align-items:center;gap:8px;}',
                '.rs-sam-primary kbd{border-color:rgba(255,255,255,.4);color:rgba(255,255,255,.85);',
                'background:rgba(255,255,255,.12);}',
                '.rs-sam-panel button:disabled{opacity:.38;cursor:default;}',
                '.rs-sam-panel button:focus-visible,.rs-sam-panel input:focus-visible{outline:2px solid #4d9dee;outline-offset:2px;}'
            ].join('');
            var style = document.createElement('style');
            style.id = 'rs-samlocal-styles';
            style.appendChild(document.createTextNode(css));
            document.head.appendChild(style);
        },

        ensurePanel: function(overlay) {
            var container = overlay.viewer.container;
            // parentNode alone is not enough: Mirador can rebuild the viewer,
            // leaving the old container detached with our panel still inside
            // it. That panel has a parentNode and is invisible to the user, so
            // the early return would keep handing it back forever.
            if (this.panel && this.panel.parentNode === container
                    && document.body.contains(this.panel)) {
                return this.panel;
            }
            if (this.panel && this.panel.parentNode) {
                this.panel.parentNode.removeChild(this.panel);
            }
            this.panel = null;
            this.ui = {};
            this.ensureStyles();
            var _this = this;
            var panel = document.createElement('div');
            panel.className = 'rs-sam-panel';
            panel.setAttribute('role', 'group');
            panel.setAttribute('aria-label', 'Segmentation controls');
            panel.innerHTML = [
                '<div class="rs-sam-head">',
                  '<span class="rs-sam-state"><i></i><span data-el="stateText">Hover to preview</span></span>',
                  '<span class="rs-sam-tally">',
                    '<span class="rs-p"><i></i><span data-el="pos">0</span> include</span>',
                    '<span class="rs-n"><i></i><span data-el="neg">0</span> exclude</span>',
                  '</span>',
                '</div>',
                '<div class="rs-sam-rows">',
                  '<div class="rs-sam-row"><span class="rs-sam-lbl">Point</span>',
                    '<span class="rs-sam-seg rs-sam-polarity" data-el="polarity">',
                      '<button type="button" data-pol="pos" aria-pressed="true"><i class="rs-pos"></i>Include</button>',
                      '<button type="button" data-pol="neg" aria-pressed="false"><i class="rs-neg"></i>Exclude</button>',
                    '</span><kbd data-el="shiftKbd">hold ⇧ to flip</kbd>',
                    '<span class="rs-sam-val rs-dim" data-el="polHint"></span></div>',
                  '<div class="rs-sam-row"><span class="rs-sam-lbl">Mask</span>',
                    '<span class="rs-sam-cyc">',
                      '<button type="button" data-el="prevMask" aria-label="Previous mask">‹</button>',
                      '<span class="rs-sam-val" data-el="maskVal">1 / 3 · 0.00</span>',
                      '<button type="button" data-el="nextMask" aria-label="Next mask">›</button>',
                    '</span><kbd>M</kbd>',
                    '<span class="rs-sam-val rs-dim" data-el="vert">— pts</span></div>',
                  '<div class="rs-sam-row"><span class="rs-sam-lbl">Edge</span>',
                    '<input type="range" data-el="thr" min="-6" max="6" step="0.25" value="0" aria-label="Mask threshold">',
                    '<span class="rs-sam-val" data-el="thrVal">0.00</span><kbd>[ ]</kbd></div>',
                  '<div class="rs-sam-row"><span class="rs-sam-lbl">Holes</span>',
                    '<button type="button" class="rs-sam-mini" data-el="holeToggle" aria-pressed="true">On</button>',
                    '<input type="range" data-el="holes" min="0" max="100" step="1" value="55" aria-label="Smallest hole to keep">',
                    '<span class="rs-sam-val" data-el="holeVal">0 / 0</span><kbd>H , .</kbd></div>',
                  '<div class="rs-sam-row"><span class="rs-sam-lbl">Outline</span>',
                    '<span class="rs-sam-seg" data-el="smooth">',
                      '<button type="button" data-lvl="0" aria-pressed="true">Raw</button>',
                      '<button type="button" data-lvl="1" aria-pressed="false">Light</button>',
                      '<button type="button" data-lvl="2" aria-pressed="false">Medium</button>',
                      '<button type="button" data-lvl="3" aria-pressed="false">Strong</button>',
                    '</span><kbd>S</kbd></div>',
                '</div>',
                '<div class="rs-sam-actions">',
                  '<button type="button" class="rs-sam-mini" data-el="undo" disabled>Undo point</button>',
                  '<span class="rs-spacer"></span>',
                  '<button type="button" class="rs-sam-ghost" data-el="cancel">Cancel</button>',
                  '<button type="button" class="rs-sam-primary" data-el="accept" disabled>Accept mask <kbd>↵</kbd></button>',
                '</div>'
            ].join('');

            var ui = {};
            Array.prototype.forEach.call(panel.querySelectorAll('[data-el]'), function(node) {
                ui[node.getAttribute('data-el')] = node;
            });
            this.ui = ui;

            // OSD's mouse tracker sits on the container; without this the panel
            // would pan the image underneath it.
            ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup',
             'click', 'dblclick', 'mousemove', 'wheel', 'touchstart'].forEach(function(type) {
                panel.addEventListener(type, function(ev) { ev.stopPropagation(); });
            });

            ui.polarity.addEventListener('click', function(ev) {
                var button = ev.target.closest ? ev.target.closest('button') : null;
                if (button) {
                    _this.polarity = button.getAttribute('data-pol');
                    _this.updatePanel();
                    _this.paintCurrentMask(overlay);
                }
            });
            ui.prevMask.addEventListener('click', function() { _this.cycleMask(overlay, -1); });
            ui.nextMask.addEventListener('click', function() { _this.cycleMask(overlay, 1); });
            ui.thr.addEventListener('input', function() {
                _this.maskThreshold = parseFloat(ui.thr.value);
                _this.paintCurrentMask(overlay);
                _this.updatePanel();
            });
            ui.holes.addEventListener('input', function() {
                _this.holeAreaRatio = _this.ratioFromSlider(parseInt(ui.holes.value, 10));
                _this.paintCurrentMask(overlay);
                _this.updatePanel();
            });
            ui.holeToggle.addEventListener('click', function() { _this.toggleHoleMode(overlay); });
            ui.smooth.addEventListener('click', function(ev) {
                var button = ev.target.closest ? ev.target.closest('button') : null;
                if (button) {
                    _this.smoothLevel = parseInt(button.getAttribute('data-lvl'), 10);
                    _this.paintCurrentMask(overlay);
                    _this.updatePanel();
                }
            });
            ui.undo.addEventListener('click', function() { _this.undoPoint(overlay); });
            ui.cancel.addEventListener('click', function() { _this.cancelMask(overlay); });
            ui.accept.addEventListener('click', function() { _this.commit(overlay); });

            container.appendChild(panel);
            this.panel = panel;
            this.syncSliders();
            this.updatePanel();
            return panel;
        },

        /** Hole ratio spans 0.02%..25% logarithmically; the slider is 0..100. */
        ratioFromSlider: function(value) {
            var lo = Math.log(0.0002), hi = Math.log(0.25);
            return Math.exp(lo + (value / 100) * (hi - lo));
        },
        sliderFromRatio: function(ratio) {
            var lo = Math.log(0.0002), hi = Math.log(0.25);
            return Math.round(((Math.log(ratio) - lo) / (hi - lo)) * 100);
        },

        /** Push state into the two sliders (after a key press moved it). */
        syncSliders: function() {
            if (!this.ui.thr) {
                return;
            }
            this.ui.thr.value = String(this.maskThreshold);
            this.ui.holes.value = String(this.sliderFromRatio(this.holeAreaRatio));
        },

        showPanel: function(overlay) {
            this.ensurePanel(overlay).hidden = false;
        },

        hidePanel: function() {
            if (this.panel) {
                this.panel.hidden = true;
            }
        },

        updatePanel: function() {
            var ui = this.ui;
            if (!ui.stateText || !this.panel) {
                return;
            }
            var polygons = this.lastResult ? this.visiblePolygons() : [];
            var vertices = polygons.reduce(function(sum, rings) {
                return sum + rings.reduce(function(n, ring) { return n + ring.length; }, 0);
            }, 0);
            var positives = 0, negatives = 0;
            this.point_labels.forEach(function(label) { label ? positives++ : negatives++; });

            this.panel.classList.toggle('is-locked', !!this.locked);
            ui.stateText.textContent = this.locked
                ? 'Locked — refine, then accept'
                : (this.lastResult ? 'Preview — click to lock' : 'Hover the image to preview');
            ui.pos.textContent = positives;
            ui.neg.textContent = negatives;
            ui.maskVal.textContent = this.lastResult
                ? (this.maskIndex + 1) + ' / ' + this.lastResult.maskCount + ' · '
                    + this.lastResult.scores[this.maskIndex].toFixed(2)
                : '—';
            ui.vert.textContent = vertices ? vertices + ' pts' : '— pts';
            ui.thrVal.textContent = (this.maskThreshold > 0 ? '+' : '') + this.maskThreshold.toFixed(2);
            ui.holeToggle.textContent = this.holeMode === 'on' ? 'On' : 'Off';
            ui.holeToggle.setAttribute('aria-pressed', String(this.holeMode === 'on'));
            ui.holes.disabled = this.holeMode !== 'on';
            ui.holeVal.textContent = this.holeMode === 'on'
                ? this.countHoles(polygons) + ' / ' + this.countHoles(this.rawPolygons())
                : 'off';
            ui.undo.disabled = !this.point_coords.length;
            ui.accept.disabled = !this.locked || !polygons.length;
            ui.prevMask.disabled = ui.nextMask.disabled =
                !this.lastResult || this.lastResult.maskCount < 2;
            ui.shiftKbd.classList.toggle('is-held', this.shiftHeld);
            ui.polarity.classList.toggle('is-flipped', this.shiftHeld && this.polarity === 'pos');
            ui.polHint.textContent = this.negativeNow()
                ? (this.locked ? 'click carves it back' : 'needs a mask first')
                : (this.locked ? 'click grows the mask' : 'click locks a mask');
            Array.prototype.forEach.call(ui.polarity.children, function(button) {
                button.setAttribute('aria-pressed',
                    String(button.getAttribute('data-pol') === this.polarity));
            }, this);
            Array.prototype.forEach.call(ui.smooth.children, function(button) {
                button.setAttribute('aria-pressed',
                    String(parseInt(button.getAttribute('data-lvl'), 10) === this.smoothLevel));
            }, this);
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
                    // The pill floats over the image, so it must not swallow
                    // clicks meant for the picture underneath; only its own
                    // dismiss button takes pointer events.
                    'pointer-events': 'none'
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
                + '<button style="margin-left: 10px; background: none; border: none; color: white; cursor: pointer; font-size: 20px; line-height: 1; vertical-align: middle; pointer-events: auto;">×</button>'
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
            // Unlocked: hover owns the mask again until the next click.
            this.locked = false;
            this.cursorCss = null;
            this.clearPreview();
            this.updatePanel();
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

        /**
         * Draw (or redraw, after pan/zoom/cycle) the selected candidate mask,
         * the prompt points and the cursor ghost. Runs with no mask too — the
         * points and ghost still have to show while a decode is in flight.
         */
        paintCurrentMask: function(overlay) {
            var entry = this.currentKey && this.encodedKeys[this.currentKey];
            if (!entry) {
                return;
            }
            var canvas = this.getPreviewCanvas(overlay);
            var ctx = canvas.getContext('2d');
            var dpr = window.devicePixelRatio || 1;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in css px from here on
            if (this.lastResult) {
                this.paintMaskPolygons(overlay, entry, ctx);
            }
            this.paintGhost(ctx);
            this.paintPoints(overlay, entry, ctx);
        },

        /** engine px -> css px, for drawing prompt markers over the image. */
        engineToCss: function(point, entry, overlay) {
            var imagePoint = this.engineToImage(point, entry);
            return overlay.viewer.viewport.pixelFromPoint(
                overlay.viewer.viewport.imageToViewportCoordinates(
                    new OpenSeadragon.Point(imagePoint[0], imagePoint[1])), true);
        },

        /** A prompt marker: green ⊕ for include, red ⊖ for exclude. */
        drawMarker: function(ctx, x, y, positive, ghost) {
            ctx.beginPath();
            ctx.arc(x, y, 8, 0, Math.PI * 2);
            ctx.fillStyle = positive
                ? (ghost ? 'rgba(31,157,85,0.32)' : '#1f9d55')
                : (ghost ? 'rgba(207,59,64,0.32)' : '#cf3b40');
            ctx.fill();
            ctx.lineWidth = 2.25;
            ctx.setLineDash(ghost ? [3, 3] : []);
            ctx.strokeStyle = ghost
                ? (positive ? 'rgba(63,192,125,0.95)' : 'rgba(239,95,99,0.95)')
                : 'rgba(255,255,255,0.92)';
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(255,255,255,0.95)';
            ctx.lineWidth = 2;
            ctx.moveTo(x - 3.5, y);
            ctx.lineTo(x + 3.5, y);
            if (positive) {
                ctx.moveTo(x, y - 3.5);
                ctx.lineTo(x, y + 3.5);
            }
            ctx.stroke();
        },

        paintPoints: function(overlay, entry, ctx) {
            var _this = this;
            this.point_coords.forEach(function(point, index) {
                var pixel = _this.engineToCss(point, entry, overlay);
                _this.drawMarker(ctx, pixel.x, pixel.y, _this.point_labels[index] === 1, false);
            });
        },

        /**
         * The polarity of the click about to be made, under the cursor. Shift
         * used to change what a click meant with nothing on screen saying so.
         */
        paintGhost: function(ctx) {
            if (!this.cursorCss || this.dragging) {
                return;
            }
            if (this.hitPointIndex(this.cursorCss) !== -1) {
                return; // that click deletes a point; don't promise a new one
            }
            this.drawMarker(ctx, this.cursorCss.x, this.cursorCss.y, !this.negativeNow(), true);
        },

        /** Index of the placed point under a css-space position, or -1. */
        hitPointIndex: function(cssPoint) {
            if (!this.overlayRef || !cssPoint) {
                return -1;
            }
            var entry = this.currentKey && this.encodedKeys[this.currentKey];
            if (!entry) {
                return -1;
            }
            for (var i = 0; i < this.point_coords.length; i++) {
                var pixel = this.engineToCss(this.point_coords[i], entry, this.overlayRef);
                if (Math.hypot(pixel.x - cssPoint.x, pixel.y - cssPoint.y) < 11) {
                    return i;
                }
            }
            return -1;
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
            this.syncSliders();
            this.updatePanel();
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
            this.updatePanel();
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
            // Kept-of-found lives in the panel now. The pill is reserved for
            // the one thing the panel cannot express: that no threshold will
            // help because the hole is below the decoder's own resolution.
            if (found === 0 && this.holeMode === 'on' && entry && this.lastMaskWidth) {
                var pxPerMaskPx = (entry.region.w / this.lastMaskWidth).toFixed(1);
                this.showStatus(
                    'No holes in this mask. The decoder works at '
                        + this.lastMaskWidth + '² over a ' + Math.round(entry.region.w)
                        + 'px region (~' + pxPerMaskPx + ' image px per mask px), so anything'
                        + ' finer than that is not in its output. Zoom in and prompt again.',
                    'info', overlay);
            } else {
                this.hideStatus();
            }
        },

        /** Nudge the hole-significance ratio (, and .) and repaint. */
        adjustHoleRatio: function(factor, overlay) {
            var next = this.holeAreaRatio * factor;
            this.holeAreaRatio = Math.min(0.25, Math.max(0.0002, next));
            this.paintCurrentMask(overlay);
            this.syncSliders();
            this.updatePanel();
            this.showHoleStatus(overlay);
        },

        /** A/B toggle for hole reclamation as a whole (H). */
        toggleHoleMode: function(overlay) {
            this.holeMode = this.holeMode === 'on' ? 'off' : 'on';
            this.paintCurrentMask(overlay);
            this.updatePanel();
            this.showHoleStatus(overlay);
        },

        /** Step through the candidate masks (M, or the panel's ‹ ›). */
        cycleMask: function(overlay, direction) {
            if (!this.lastResult || this.lastResult.maskCount < 2) {
                return;
            }
            var count = this.lastResult.maskCount;
            this.maskIndex = (this.maskIndex + (direction || 1) + count) % count;
            this.paintCurrentMask(overlay);
            this.updatePanel();
        },

        /**
         * Drop the last prompt point. With none left the mask has nothing
         * asserting it, so we fall back to hovering rather than keeping a
         * shape on screen that no point explains.
         */
        undoPoint: function(overlay) {
            if (!this.point_coords.length) {
                return;
            }
            this.removePoint(overlay, this.point_coords.length - 1);
        },

        removePoint: function(overlay, index) {
            this.point_coords.splice(index, 1);
            this.point_labels.splice(index, 1);
            if (!this.point_coords.length && !this.box) {
                this.locked = false;
                this.lastResult = null;
                this.rawCache = null;
                this.polygonCache = null;
                this.paintCurrentMask(overlay);
                this.updatePanel();
                return;
            }
            var engine = window.RsSamEngine;
            var _this = this;
            this.requestDecode(overlay, engine, null).then(function() {
                _this.updatePanel();
            });
        },

        /** Throw the mask away and go back to hovering (Cancel, Esc). */
        cancelMask: function(overlay) {
            var key = this.currentKey;
            this.resetOverlayState();
            this.currentKey = key; // the embedding is still good; keep it
            this.updatePanel();
        },

        /** True while the keystroke belongs to something the user is typing in. */
        isTypingTarget: function(node) {
            if (!node) {
                return false;
            }
            var tag = node.tagName;
            return node.isContentEditable || tag === 'TEXTAREA' || tag === 'SELECT'
                || (tag === 'INPUT' && node.type !== 'range' && node.type !== 'checkbox');
        },

        /** Preview repaint on pan/zoom, the keyboard accelerators, tool changes. */
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

            // Ride the overlay's own cleanup list, so destroy() unsubscribes
            // these along with its own (osd-svg-overlay.js destroy()).
            var subscribe = function(name, handler) {
                overlay.eventsSubscriptions.push(
                    overlay.eventEmitter.subscribe(name + '.' + overlay.windowId, handler));
            };

            // Selecting another drawing tool has to put this one away —
            // otherwise its panel keeps floating over someone else's rectangle.
            subscribe('toggleDrawingTool', function(event, tool) {
                if (tool === _this.logoClass) {
                    _this.arm(overlay);
                } else {
                    _this.detach(overlay);
                }
            });

            // The exits that never publish toggleDrawingTool. Saving an
            // annotation, choosing the HUD pointer, and switching the
            // annotation layer off all land in enterDisplayAnnotations ->
            // disable()/checkToRemoveFocus, which clears overlay.currentTool
            // without telling the tool anything — so without this the panel
            // stayed on screen, fully dead.
            //
            // modeChange is the one signal every HUD transition publishes
            // (hud.js onchoosePointer / ondisplayOff / onchooseShape).
            // 'creatingAnnotation' is the only mode where a drawing tool is
            // live, and which tool that is comes from toggleDrawingTool above.
            subscribe('modeChange', function(event, mode) {
                if (mode !== 'creatingAnnotation') {
                    _this.detach(overlay);
                }
            });
            subscribe('CANCEL_ACTIVE_ANNOTATIONS', function() { _this.detach(overlay); });

            var onKeyDown = function(keyEvent) {
                if (overlay.currentTool !== _this || _this.isTypingTarget(keyEvent.target)) {
                    return;
                }
                if (keyEvent.key === 'Shift' && !_this.shiftHeld) {
                    _this.shiftHeld = true;
                    _this.paintCurrentMask(overlay);
                    _this.updatePanel();
                    return;
                }
                if (keyEvent.key === 'Escape') {
                    _this.cancelMask(overlay);
                    return;
                }
                if (keyEvent.key === 'Enter') {
                    if (_this.locked) {
                        _this.commit(overlay);
                    }
                    return;
                }
                if (keyEvent.key === 'Backspace' || keyEvent.key === 'Delete') {
                    if (_this.point_coords.length) {
                        keyEvent.preventDefault();
                        _this.undoPoint(overlay);
                    }
                    return;
                }
                if (!_this.lastResult) {
                    return;
                }
                if (keyEvent.key === 'm' || keyEvent.key === 'M') {
                    _this.cycleMask(overlay, 1);
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
            };
            document.addEventListener('keydown', onKeyDown);

            // Shift is momentary, so the ghost has to follow the key itself
            // and not wait for the next mouse move.
            var releaseShift = function() {
                if (_this.shiftHeld) {
                    _this.shiftHeld = false;
                    _this.paintCurrentMask(overlay);
                    _this.updatePanel();
                }
            };
            var onKeyUp = function(keyEvent) {
                if (keyEvent.key === 'Shift') {
                    releaseShift();
                }
            };
            document.addEventListener('keyup', onKeyUp);
            window.addEventListener('blur', releaseShift);

            // Tools are constructed per overlay, and overlays per window, so
            // without this every window close left another keydown handler on
            // document bound to a dead viewer — one whose `currentTool === this`
            // guard still passes, so a stray keystroke drove a tool whose
            // viewer was gone.
            var torndown = false;
            var teardown = function() {
                if (torndown) {
                    return;
                }
                torndown = true;
                document.removeEventListener('keydown', onKeyDown);
                document.removeEventListener('keyup', onKeyUp);
                window.removeEventListener('blur', releaseShift);
                overlay.viewer.removeHandler('animation', repaint);
                overlay.viewer.removeHandler('animation-finish', repaint);
                _this.detach(overlay);
                _this.releaseEmbeddings();
                if (_this.panel && _this.panel.parentNode) {
                    _this.panel.parentNode.removeChild(_this.panel);
                }
                _this.panel = null;
                _this.ui = {};
                _this.viewerHooked = false;
            };
            // DESTROY_EVENTS only, and NOT through subscribe(): the overlay
            // subscribed to it first and its handler unsubscribes that whole
            // list, so a teardown parked there may never run. We unsubscribe
            // ourselves instead. OSD's 'close' is deliberately not used — it
            // fires whenever the viewer re-opens an image, which would tear
            // the tool down mid-session.
            var destroyEvent = 'DESTROY_EVENTS.' + overlay.windowId;
            var onDestroy = function() {
                overlay.eventEmitter.unsubscribe(destroyEvent, onDestroy);
                teardown();
            };
            overlay.eventEmitter.subscribe(destroyEvent, onDestroy);
        },

        /**
         * Put the tool away: no mask, no points, no panel. Called for every
         * exit, including the ones Mirador does not announce as a tool change.
         *
         * Embeddings deliberately survive — they are LRU-capped at 3 and cost
         * a second each to rebuild, so paying that on every pointer-mode
         * detour would be worse than holding them. releaseEmbeddings() runs at
         * teardown, when the viewer is actually going away.
         */
        detach: function(overlay) {
            this.resetOverlayState();
            this.hidePanel();
        },

        /** Hand the worker back its per-viewport tensors (tens of MB each). */
        releaseEmbeddings: function() {
            var engine = window.RsSamEngine;
            if (engine) {
                this.keyOrder.forEach(function(key) { engine.release(key); });
            }
            this.encodedKeys = {};
            this.keyOrder = [];
            this.currentKey = null;
        },

        /**
         * Selecting the tool has to actually arm it, which is not a given.
         * Coming from pointer mode the HUD publishes toggleDrawingTool AND a
         * state-machine transition; the transition lands in enterCreateShape
         * (osd-region-draw-tool.js), which only re-enables the overlay when
         * inEditOrCreateMode is false, and otherwise calls checkToRemoveFocus()
         * — clearing overlay.currentTool right back out. That flag is only
         * reset inside the annotationCreated callback, so after a save the
         * toolbar showed this tool selected while it received no mouse events
         * at all, with no way back short of reloading the page.
         *
         * Repaired here rather than in osd-region-draw-tool.js because that
         * file is shared by every drawing tool. Deferred a tick so it runs
         * after the state machine has finished, whichever order the two events
         * arrive in.
         */
        arm: function(overlay) {
            var _this = this;
            this.showPanel(overlay);
            setTimeout(function() {
                if (overlay.currentTool === _this && !overlay.disabled) {
                    return; // armed normally, nothing to repair
                }
                if (!_this.panel || _this.panel.hidden) {
                    return; // another tool won in the meantime
                }
                console.warn('SamLocal: overlay left inert after the previous annotation; re-arming.');
                overlay.inEditOrCreateMode = false;
                overlay.disabled = false;
                overlay.currentTool = _this;
                overlay.show();
                overlay.viewer.setMouseNavEnabled(false);
            }, 0);
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
            // The pill announced this work; it has to retract it. Nothing else
            // will: since the panel took over the readouts, the only remaining
            // hideStatus calls are on a click, a reset and the post-commit
            // timer — so a re-encode from pan/zoom left "Preparing image…" on
            // screen for as long as the user kept hovering.
            this.hideStatus();
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
                    _this.updatePanel();
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
            this.overlayRef = overlay;
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

            // A click on a placed marker removes it — the only way to correct a
            // misplaced point used to be abandoning the whole mask.
            if (!wasDrag) {
                var hitIndex = this.hitPointIndex(downCss);
                if (hitIndex !== -1) {
                    this.removePoint(overlay, hitIndex);
                    return;
                }
            }

            var negative = this.negativeNow(event.event.shiftKey);
            // A negative point on its own says "not this" about nothing. SAM
            // needs something to subtract from; refuse rather than decode it.
            if (!wasDrag && negative && !this.locked) {
                this.showStatus(
                    "Nothing to exclude yet — click the object first, then exclude parts of it.",
                    "warning", overlay);
                return;
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
                this.point_labels.push(negative ? 0 : 1);
            }
            // The first prompt locks: from here the mask is the user's, and
            // hovering no longer re-segments it out from under them.
            this.locked = true;
            this.pendingHover = null; // the explicit prompt supersedes any queued hover
            this.hideStatus();
            this.updatePanel();

            try {
                await this.requestDecode(overlay, engine, null);
                this.updatePanel();
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
            if (!engine) {
                return;
            }
            this.overlayRef = overlay;
            this.showPanel(overlay);
            this.shiftHeld = !!event.event.shiftKey;
            this.cursorCss = { x: event.event.offsetX, y: event.event.offsetY };
            if (this.dragging) {
                return;
            }
            var _this = this;
            if (!this.currentKey || !this.encodedKeys[this.currentKey]) {
                if (!this.embeddingPromise) {
                    this.ensureEmbedding(overlay, engine).then(function() {
                        _this.updatePanel();
                    }).catch(function(error) {
                        _this.showStatus("Failed to prepare image: " + error.message, "error", overlay);
                    });
                }
                return;
            }
            // Locked: the mask belongs to the placed points now. Repaint so the
            // cursor ghost still tracks, but do not re-segment.
            if (this.locked) {
                this.paintCurrentMask(overlay);
                this.updatePanel();
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

        /**
         * Deliberately inert. The overlay only recognises a double-click on the
         * second mousedown, by which time the first click has already placed a
         * point and re-decoded — so committing here saved a mask the user never
         * saw. Accept is a button, Enter, or alt/cmd+click.
         */
        onDoubleClick: function(event, overlay) {},

        commit: function(overlay) {
            if (overlay.mode !== 'create') {
                return;
            }
            if (!this.locked || !this.lastResult || !this.visiblePolygons().length) {
                this.showStatus("Nothing to save yet — click the object first.", "warning", overlay);
                return;
            }
            try {
                var entry = this.encodedKeys[this.currentKey];
                // The same call the preview uses, so commit stores exactly
                // the geometry that is on screen at the current settings.
                overlay.path = this.createPathsFromPolygons(this.visiblePolygons(), overlay, entry);
                overlay.onDrawFinish();
                overlay.mode = '';
                // Reset now, not on a timer. The shape belongs to the overlay
                // from here, and a deferred reset could fire in the middle of
                // the next hover and wipe the mask under the cursor.
                this.resetOverlayState();
                this.showStatus("Segmentation complete!", "info", overlay);
                var _this = this;
                this.statusTimeout = setTimeout(function() { _this.hideStatus(); }, 2000);
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
