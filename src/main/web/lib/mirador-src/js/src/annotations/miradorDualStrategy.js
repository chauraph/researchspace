(function($) {

  $.MiradorDualStrategy = function(options) {
    jQuery.extend(this, {

    }, options);
    this.init();
  };

  $.MiradorDualStrategy.prototype = {
    init: function() {

    },

    // Check whether an annotation is supported under this formatting strategy
    isThisType: function(annotation) {
      if (annotation.on && jQuery.isArray(annotation.on) && annotation.on.length > 0 && typeof annotation.on[0] === 'object' &&
          annotation.on[0].selector && typeof annotation.on[0].selector === 'object' &&
          annotation.on[0].selector['@type'] === 'oa:Choice' &&
          annotation.on[0].selector.default && typeof annotation.on[0].selector.default === 'object' &&
          annotation.on[0].selector.default.value && typeof annotation.on[0].selector.default.value === 'string' &&
          annotation.on[0].selector.item && typeof annotation.on[0].selector.item === 'object' &&
          annotation.on[0].selector.item.value && typeof annotation.on[0].selector.item.value === 'string'
        ) {
        return annotation.on[0].selector.default.value.indexOf('xywh=') === 0 && annotation.on[0].selector.item.value.indexOf('<svg') === 0;
      }
      return false;
    },

    // Build the selector into a bare annotation, given a Window and an OsdSvgOverlay
    buildAnnotation: function(options) {
      var oaAnno = options.annotation,
          win = options.window,
          overlay = options.overlay;
      oaAnno.on = [];
      jQuery.each(overlay.draftPaths, function(index, path) {
        // getSVGString expects an array, so insert each path into a new array
        var svg = overlay.getSVGString([path]),
        bounds = path.bounds;
        oaAnno.on.push({
          "@type": "oa:SpecificResource",
          "full": win.canvasID,
          "selector": {
            "@type": "oa:Choice",
            "default": {
              "@type": "oa:FragmentSelector",
              "value": "xywh=" + Math.round(bounds.x) + "," + Math.round(bounds.y) + "," + Math.round(bounds.width) + "," + Math.round(bounds.height)
            },
            "item": {
              "@type": "oa:SvgSelector",
              "value": svg
            }
          },
          "within": {
            "@id": win.loadedManifest,
            "@type": "sc:Manifest"
          }
        });
      });
      return oaAnno;
    },

    // Parse the annotation into the OsdRegionDrawTool instance (only if its format is supported by this strategy)
	parseRegion: function(annotation, osdRegionDrawTool) {
		if (this.isThisType(annotation)) {
		  var regionArray = [];
		  
		  jQuery.each(annotation.on, function(index, target) {
			// Get the SVG string
			var svgString = target.selector.item.value;
			
			// Create a DOM parser to extract the individual paths
			var parser = new DOMParser();
			var svgDoc = parser.parseFromString(svgString, "text/xml");
			
			// Check if parsing succeeded
			if (svgDoc.documentElement.nodeName === 'parsererror') {
			  console.error("Error parsing SVG");
			  return [];
			}
			
			// Get the SVG's xmlns attribute
			var xmlns = svgDoc.documentElement.getAttribute("xmlns") || "http://www.w3.org/2000/svg";
			
			// Get all path elements
			var paths = svgDoc.querySelectorAll("path");
			//console.log("Found", paths.length, "paths in SVG for annotation", annotation['@id']);
			
			// Process each path individually
			for (var i = 0; i < paths.length; i++) {
			  // Create a new SVG with just this path
			  var individualSvg = '<svg xmlns="' + xmlns + '">' + paths[i].outerHTML + '</svg>';
			  
			  // Log for debugging
			  //console.log("Processing path", i + 1, "for annotation", annotation['@id']);
			  
			  // Parse this SVG and add resulting regions to our array
			  var pathRegions = osdRegionDrawTool.svgOverlay.parseSVG(individualSvg, annotation);
			  if (pathRegions) {
				regionArray = regionArray.concat(pathRegions);
			  }
			}
		  });
		  
		  return regionArray;
		}
	  },
  };

}(Mirador));
