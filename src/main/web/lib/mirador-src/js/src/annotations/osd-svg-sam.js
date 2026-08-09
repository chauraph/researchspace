(function($) {
    $.Sam = function(options) {
        jQuery.extend(this, {
            name: 'Sam',
            logoClass: 'flare',
            idPrefix: 'sam_',
            tooltip: 'samTooltip',
        }, options);

        this.init();
    };

    $.Sam.prototype = {
		init: function() {
			// Initialize any instance properties
			this.statusOverlay = null;
			this.statusTimeout = null;
		},

		// Status overlay methods
		initStatusOverlay: function(overlay) {
			// Always remove any existing overlay first
			if (this.statusOverlay) {
				this.statusOverlay.remove();
				this.statusOverlay = null;
			}
			
			// Create new overlay
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
			// Always check if overlay is attached to DOM, recreate if needed
			if (!this.statusOverlay || !this.statusOverlay.parent().length || this.statusOverlay.parents('body').length === 0) {
				this.initStatusOverlay(overlay);
			}
			
			// Clear any existing timeout
			if (this.statusTimeout) {
				clearTimeout(this.statusTimeout);
				this.statusTimeout = null;
			}
			
			// Set color based on type
			const colors = {
				'info': 'rgba(0, 123, 255, 0.8)',
				'warning': 'rgba(255, 193, 7, 0.8)',
				'error': 'rgba(220, 53, 69, 0.8)'
			};
			
			// Update message content
			this.statusOverlay.css('background-color', colors[type] || colors.info);
			this.statusOverlay.html(message
				+ '<button style="margin-left: 10px; background: none; border: none; color: white; cursor: pointer; font-size: 20px; line-height: 1; vertical-align: middle;">×</button>'
			);
			
			// Remove any existing click handlers to prevent multiple bindings
			this.statusOverlay.find('button').off('click').on('click', () => this.hideStatus());
			
			// Show overlay
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

		// Add cleanup method to reset overlay state
		resetOverlayState: function() {
			this.hideStatus();
			// Reset session-specific variables
			this.point_coords = [];
			this.point_labels = [];
			this.mask_input = [];
			this.sam_session_id = null;
			this.canvasImageBlob = null;
		},

		createPathsFromSegmentationMask: function(pointsArray, overlay) {
			var _this = this;
	
			// Clear any temporary points or shapes from the Paper.js canvas
			overlay.paperScope.project.activeLayer.removeChildren();
	
			// Iterate over polygons and create a shape for each
			const polygons = pointsArray; 
			const shapes = polygons.map((polygon, index) => {
				const flattenedPoints = polygon[0];
	
				const paperPoints = flattenedPoints.map(point => 
					new overlay.paperScope.Point(point[0], point[1])
				);
	
				var shape = new overlay.paperScope.Path({
					segments: paperPoints,
					closed: true,
					dashArray: overlay.dashArray,
					strokeColor: overlay.strokeColor,
					name: `${overlay.getName(_this)}_${index}`,
				});
	
				shape.data.strokeWidth = overlay.strokeWidth;
				shape.strokeWidth = shape.data.strokeWidth / overlay.paperScope.view.zoom;
	
				return shape;
			});
	
			return shapes;
		},


		// Create a reference point
		createRefPoint: function(event, overlay) {
			overlay.mode = 'create';
			var _this = this;

			var shape = new overlay.paperScope.Path.Circle({
				center: event.point,
				radius: 5 / overlay.paperScope.view.zoom,
				fillColor: event.event.shiftKey ? 'blue' : 'red',
				name: "temp_sam_input_point"
			});

			shape.data.strokeWidth = overlay.strokeWidth;
			shape.strokeWidth = shape.data.strokeWidth / overlay.paperScope.view.zoom;
			return shape;
		},

		updateSelection: function(selected, item, overlay) {
			// Empty block
		},

		onResize: function(item, overlay) {
			// Empty block
		},

		onHover: function(activate, shape, hoverWidth, hoverColor) {
			// Empty block
		},

		onMouseUp: function(event, overlay) {
			// Empty block
		},

		onMouseDrag: function(event, overlay) {
			// Empty block
		},

		onMouseMove: function(event, overlay) {
			// Empty block
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

		// Update the segmentation mask on the overlay
		updateOverlay: async function(overlay, maskBase64) {
			var canvas = overlay.viewer.drawer.canvas;
			var ctx = canvas.getContext('2d');

			// Save the initial canvas state on the first call
			if (!overlay.initialState) {
				try {
					overlay.initialState = ctx.getImageData(0, 0, canvas.width, canvas.height);
				} catch (error) {
					const imageBitmap = await createImageBitmap(this.canvasImageBlob);
					const tempCanvas = document.createElement('canvas');
					tempCanvas.width = canvas.width;
					tempCanvas.height = canvas.height;
					const tempCtx = tempCanvas.getContext('2d');
					console.log(tempCanvas.width, canvas.width, imageBitmap.width)
					tempCtx.drawImage(imageBitmap, 
						tempCanvas.width * this.getNormalizedXOffset(overlay), 
						tempCanvas.height * this.getNormalizedYOffset(overlay), 
						tempCanvas.width * (1 - 2 * this.getNormalizedXOffset(overlay)), 
						tempCanvas.height * (1 - 2 * this.getNormalizedYOffset(overlay)));
					overlay.initialState = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
				}
			}
			// Restore the initial canvas state
			ctx.putImageData(overlay.initialState, 0, 0);

			const maskImage = new Image();
			console.log(maskBase64)
			maskImage.src = `data:image/png;base64,${maskBase64}`;

			maskImage.onload = () => {
				// Overlay the mask onto the main canvas
				ctx.globalAlpha = 0.5;
				ctx.drawImage(maskImage, 0, 0, canvas.width, canvas.height);
				ctx.globalAlpha = 1.0;
			};
		},

        // Handle mouse down: Drop a reference point
        onMouseDown: async function(event, overlay) {
			if (event.event.metaKey || event.event.altKey) {
				this.genPathsAndDestroySession(overlay);
				return;
			}
			var hitResult = overlay.paperScope.project.hitTest(event.point, overlay.hitOptions);

			if (hitResult && hitResult.item._name.toString().indexOf(this.idPrefix) !== -1) {
				console.log('Clicked on an existing reference point:', hitResult.item);
				hitResult.item.fillColor = 'blue';
			} else {
				if (overlay.mode !== 'create') {
					overlay.mode = 'create';
				}

				// If this is the first reference point, set image embedding with viewport image
				window.overlayInstance = overlay;
				console.log("isFirstPoint:", (this.countShapebyName(overlay, "temp_sam_input_point") == 0));
				if (this.countShapebyName(overlay, "temp_sam_input_point") == 0) {
					// Reset state for new session
					this.resetOverlayState();
					overlay.mask = false;
					overlay.initialState = false;
					
					// Show initializing status
					this.showStatus("Initializing segmentation model...", "info", overlay);
					
					try {
						this.sam_session_id = await fetch('../proxy/segmentation/create-session', { method: 'POST' })
							.then(response => response.json())
							.then(data => {
								this.showStatus("Model ready. Click to add points.", "info", overlay);
								return data.session_id;
							});
						console.log(this.sam_session_id);
					} catch (error) {
						this.showStatus("Failed to initialize model: " + error.message, "error", overlay);
						return;
					}

					try {
						this.canvasImageBlob = await this.getViewportImageFromCanvas(overlay);
						this.showStatus("Processing image...", "info", overlay);
						await this.setImageEmbedding(overlay, this.canvasImageBlob);
					} catch(error) {
						this.showStatus("Fetching image via IIIF...", "info", overlay);
						try {
							[this.canvasImageBlob, iiifRequestUrl] = await this.getViewportImageFromIIIF(overlay);
							await this.setImageEmbeddingViaIIIF(overlay, iiifRequestUrl);
						} catch(error) {
							this.showStatus("Trying alternative method...", "info", overlay);
							try {
								await this.setImageEmbedding(overlay, this.canvasImageBlob, true);
							} catch(error) {
								this.showStatus("Failed to prepare image: " + error.message, "error", overlay);
								return;
							}
						}
					}
					this.showStatus("Ready for segmentation. Click to add points.", "info", overlay);
				}

                // Capture the click position in the viewport
                console.log(event);
                this.point_coords.push([event.event.offsetX, event.event.offsetY]);

                // Determine pos and neg points
                this.point_labels.push(event.event.shiftKey ? 0 : 1);
                console.log(this.point_coords, this.point_labels);

                // Create a new reference point at the click location
                overlay.path = this.createRefPoint(event, overlay);

                // Show processing status
                this.showStatus("Processing segmentation...", "info", overlay);
                
                try {
                    // Perform inference
                    [overlay.mask, overlay.approx_points] = await this.inference(overlay, this.point_coords, this.point_labels, overlay.mask);
                    console.log(overlay.mask);

                    // Update the overlay with a binary mask and store the mask
                    await this.updateOverlay(overlay, overlay.mask);
                    
                    this.showStatus("Segmentation updated.<br>Click to add more positive points or negative points (hold left shift).<br>To save current mask, hold left alt-key (PC) or command-key (Mac) + click.", "info", overlay);
                } catch(error) {
                    this.showStatus("Segmentation failed: " + error.message, "error", overlay);
                }
            }
        },

        onDoubleClick: function(event, overlay) {
            this.genPathsAndDestroySession(overlay);
        },

        genPathsAndDestroySession: function(overlay) {
			if (overlay.mode === 'create') {
				this.showStatus("Finalizing segmentation...", "info", overlay);
				
				try {
					overlay.path = this.createPathsFromSegmentationMask(overlay.approx_points, overlay);
					overlay.onDrawFinish();
					var canvas = overlay.viewer.drawer.canvas;
					var ctx = canvas.getContext('2d');
					ctx.putImageData(overlay.initialState, 0, 0);
					console.log("redraw");
					overlay.initialState = null;
					overlay.mode = '';
					
					const formData = new FormData();
					formData.append('session_id', this.sam_session_id);
					fetch('../proxy/segmentation/destroy-session', {
						method: 'POST',
						body: formData,
						mode: 'cors'
					}).then(() => {
						this.showStatus("Segmentation complete!", "info", overlay);
						setTimeout(() => {
							this.hideStatus();
							// Reset for next use
							this.resetOverlayState();
						}, 2000);
					}).catch(error => {
						// Still show success but log error
						console.error("Error cleaning up session:", error);
						this.showStatus("Segmentation complete!", "info", overlay);
						setTimeout(() => {
							this.hideStatus();
							// Reset for next use
							this.resetOverlayState();
						}, 2000);
					});
				} catch(error) {
					this.showStatus("Failed to finalize segmentation: " + error.message, "error", overlay);
				}
			}
		},

		setImageEmbedding: async function(overlay, canvasImageBlob, padImage = false) {
			try {
				
				const formData = new FormData();
				formData.append('image', canvasImageBlob, 'image.png');
				if (padImage) {
					formData.append('normalizedXOffset', this.getNormalizedXOffset(overlay));
					formData.append('normalizedYOffset', this.getNormalizedYOffset(overlay));
				}
				formData.append('session_id', this.sam_session_id);
		
				this.showStatus("Setting image embedding...", "info", overlay);
				
				const response = await fetch('../proxy/segmentation/image', {
					method: 'POST',
					body: formData,
					mode: 'cors'
				});
		
				if (response.ok) {
					const result = await response.json();
					console.log('Set image embedding successful:', result);
					this.showStatus("Image processed successfully", "info", overlay);
				} else {
					this.showStatus("Failed to process image: " + response.statusText, "error", overlay);
					throw new Error('Set image embedding failed: ' + response.statusText);
				}
			} catch (error) {
				this.showStatus("Error processing image: " + error.message, "error", overlay);
				throw new Error('Error in setImageEmbedding: ' + error);
			}
		},
		
		setImageEmbeddingViaIIIF: async function(overlay, iiifRequestUrl) {
			try {
				
				const formData = new FormData();
				formData.append('iiifRequestUrl', iiifRequestUrl);
				formData.append('normalizedXOffset', this.getNormalizedXOffset(overlay));
				formData.append('normalizedYOffset', this.getNormalizedYOffset(overlay));
				formData.append('session_id', this.sam_session_id);
		
				this.showStatus("Setting image embedding...", "info", overlay);
				
				const response = await fetch('../proxy/segmentation/IIIFimage', {
					method: 'POST',
					body: formData,
					mode: 'cors'
				});
		
				if (response.ok) {
					const result = await response.json();
					console.log('Set image embedding successful:', result);
					this.showStatus("IIIF image processed successfully", "info", overlay);
				} else {
					this.showStatus("Failed to process IIIF image: " + response.statusText, "error", overlay);
					throw new Error('Set image embedding failed: ' + response.statusText);
				}
			} catch (error) {
				this.showStatus("Error processing IIIF image: " + error.message, "error", overlay);
				throw new Error('Error in setImageEmbeddingViaIIIF: ' + error);
			}
		},

		// Capture the current viewport image and convert it to a Blob
		getViewportImageFromCanvas: function(overlay) {
			var viewer = overlay.viewer;
			var canvas = viewer.drawer.canvas;
			var tempCanvas = document.createElement('canvas');
			var tempContext = tempCanvas.getContext('2d');

			var viewportSize = viewer.viewport.getContainerSize();
			tempCanvas.width = viewportSize.x;
			tempCanvas.height = viewportSize.y;

			tempContext.drawImage(canvas, 0, 0, tempCanvas.width, tempCanvas.height);

			console.log(tempCanvas.toDataURL('image/png'));

			return new Promise((resolve) => {
				tempCanvas.toBlob((blob) => {
					resolve(blob);
				}, 'image/png');
			});
		},

		getNormalizedXOffset: function(overlay) {
			return -Math.min(overlay.viewer.viewport.getBounds().x, 0) / overlay.viewer.viewport.getBounds().width;
		},

		getXOffset: function(overlay) {
			return this.getNormalizedXOffset(overlay) * overlay.viewer.viewport.getContainerSize().x;
		},

		getNormalizedYOffset: function(overlay) {
			return -Math.min(overlay.viewer.viewport.getBounds().y, 0) / overlay.viewer.viewport.getBounds().height;
		},

		getYOffset: function(overlay) {
			return this.getNormalizedYOffset(overlay) * overlay.viewer.viewport.getContainerSize().y;
		},
		
		// Fetch the current viewport image using IIIF image region request and convert it to a Blob
		getViewportImageFromIIIF: function(overlay) {
			return new Promise((resolve, reject) => {
				var viewer = overlay.viewer;
				var viewportSize = viewer.viewport.getContainerSize();

				// Get valid IIIF Region from current viewport
				var { x, y, w, h } = this.getIIIFRegionFromViewport(viewer);

				// Construct the IIIF image region request URL
				var iiifImageUrl = viewer.world.getItemAt(0).source['@id'];
				console.log(viewer.world.getItemAt(0))
				var region = `${x},${y},${w},${h}`;
				var size = `${Math.round(viewportSize.x * (1 - this.getNormalizedXOffset(overlay) * 2))},${Math.round(viewportSize.y * (1 - this.getNormalizedYOffset(overlay) * 2))}`; // Use rendered size for the output image
				var iiifRequestUrl = `${iiifImageUrl}/${region}/${size}/0/default.jpg`;

				fetch(iiifRequestUrl)
					.then(response => response.blob())
					.then(blob => {
						console.log('IIIF Request URL:', iiifRequestUrl);
						console.log(blob)

						resolve([blob, iiifRequestUrl]);
					})
					.catch(error => {
						console.error('Failed to fetch image from IIIF server:', error);
						reject(error);
					});
			});
		},

        inference: async function(overlay, point_coords, point_labels, mask_input) {
            try {
                var viewer = overlay.viewer;
                
                const formData = new FormData();
                formData.append("click_list", point_coords);
                formData.append("type", point_labels);
                if (mask_input) {
                    formData.append("mask_input", mask_input);
                }
                formData.append("viewport", [Object.values(overlay.viewer.viewport.getBounds())]);
                formData.append('session_id', this.sam_session_id);

                const response = await fetch('../proxy/segmentation/click', {
                    method: 'POST',
                    body: formData,
                    mode: 'cors'
                });

                if (response.ok) {
                    const result = await response.json();
                    console.log('Inference successful:', result.message);
                    return [result.masks, result.approx_points];
                } else {
                    this.showStatus("Server error: " + response.statusText, "error", overlay);
                    console.error('Inference failed:', response.statusText);
                    throw new Error("Server error: " + response.statusText);
                }
            } catch (error) {
                console.error('Error in inference:', error);
                throw error;
            }
        },

		getIIIFRegionFromViewport: function(viewer) {
			var viewportBounds = viewer.viewport.getBounds();

			// Get the actual image dimensions
			var imageSize = viewer.world.getItemAt(0).getContentSize();
			var imageWidth = imageSize.x;
			var imageHeight = imageSize.y;

			// Convert viewport bounds to IIIF region format (xywh)
			var x = Math.floor(viewportBounds.x);
			var y = Math.floor(viewportBounds.y);
			var w = Math.floor(viewportBounds.width);
			var h = Math.floor(viewportBounds.height);

			// Clamp the region coordinates to ensure they are within the image bounds
			x = Math.max(0, x); // Ensure x is not negative
			y = Math.max(0, y); // Ensure y is not negative
			w = Math.min(imageWidth - x, w); // Ensure width does not exceed image bounds
			h = Math.min(imageHeight - y, h); // Ensure height does not exceed image bounds

			return { x, y, w, h };
		}
	};
}(Mirador));

