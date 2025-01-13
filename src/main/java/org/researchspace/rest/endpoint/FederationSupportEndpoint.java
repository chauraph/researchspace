/**
 * ResearchSpace
 * Copyright (C) 2020, © Trustees of the British Museum
 * Copyright (C) 2015-2019, metaphacts GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.

 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

package org.researchspace.rest.endpoint;

import static javax.ws.rs.core.MediaType.APPLICATION_JSON;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.researchspace.rest.feature.CacheControl.NoCache;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jayway.jsonpath.JsonPath;
import com.jayway.jsonpath.DocumentContext;
import javax.servlet.http.HttpServletRequest;
import javax.ws.rs.GET;
import javax.ws.rs.Path;
import javax.ws.rs.Produces;
import javax.ws.rs.QueryParam;
import javax.ws.rs.core.Context;
import javax.ws.rs.core.UriInfo;

import java.net.URL;
import java.io.IOException;
import java.net.MalformedURLException;
import org.apache.commons.io.IOUtils;
import java.nio.charset.StandardCharsets;

/**
 * Endpoint to support Ephedra Federation
 * @author Tsz-Kin (Raphael) Chau <chauraph@gmail.com> <tszkin.chau@epfl.ch>
 */
@Path("")
public class FederationSupportEndpoint {
    private static final Logger logger = LogManager.getLogger(URLMinifierEndpoint.class);

    @Context
    UriInfo uri;

    @Context
    HttpServletRequest request;

    /*
     * Simple proxy service to pass IIIF manifest to the Ephedra Federation client accessible only from localhost 
     * When processForImageImport = true: Augment manifest id to the canvas level (_manifest) to support semantic-search
     */
    @GET()
    @NoCache
    @Path("iiifProxy")
    @Produces(APPLICATION_JSON)
    public String iiifProxy(@QueryParam("manifest") String manifest,
                            @QueryParam("processForImageImport") boolean processForImageImport) throws Exception {
        
        logger.info("Received manifest URL: {}", manifest);

        String clientIp = request.getRemoteAddr();

        // Todo: implement proper javax filter
        if (!clientIp.equals("127.0.0.1") && !clientIp.equals("::1")) {
            logger.error("Unauthorized access attempt from IP: {}", clientIp);
            throw new SecurityException("Access denied: Only localhost is allowed to access this endpoint.");
        }

        URL manifestURL;
        try {
            manifestURL = new URL(manifest);
        } catch (MalformedURLException e) {
            logger.error("Invalid URL format for manifest: {}", manifest);
            throw new IllegalArgumentException("Invalid URL format");
        }

        String jsonContent;
        try {
            jsonContent = IOUtils.toString(manifestURL, StandardCharsets.UTF_8);
        } catch (IOException e) {
            logger.error("IO error occurred while fetching manifest: {}", manifest, e);
            throw new RuntimeException("Failed to fetch manifest due to IO error", e);
        } catch (Exception e) {
            logger.error("Unexpected error occurred: {}", manifest, e);
            throw new RuntimeException("An unexpected error occurred while fetching manifest", e);
        }

        JsonNode rootNode;
        DocumentContext jsonContext;
        try {
            ObjectMapper objectMapper = new ObjectMapper();
            rootNode = objectMapper.readTree(jsonContent); // Parse JSON to verify validity
            jsonContext = JsonPath.parse(jsonContent);
        } catch (Exception e) {
            logger.error("Manifest content is not valid JSON: {}", jsonContent);
            throw new IllegalArgumentException("Manifest is not a valid JSON file", e);
        }

        if (!rootNode.has("@context")) { // Check if JSON is JSON-LD
            logger.error("Manifest JSON does not contain '@context': {}", jsonContent);
            throw new IllegalArgumentException("Invalid JSON-LD: '@context' is missing");
        }

        String context = rootNode.get("@context").asText();
        context = context.replaceFirst("^https?://", ""); // Normalize to match only the path
        String idValue = null;

        // Switch IIIF presentation API v2 and v3 by the value of "@context"
        switch (context) {
            case "iiif.io/api/presentation/2/context.json":
                if (!rootNode.has("@id")) {
                    logger.error("Manifest JSON does not contain '@id': {}", jsonContent);
                    throw new IllegalArgumentException("Invalid JSON-LD: '@id' is missing");
                }
                if (processForImageImport) {
                    idValue = rootNode.get("@id").asText();
                    jsonContext.put("$..sequences[*].canvases[*]", "_manifest", idValue);
                }
                break;

            case "iiif.io/api/presentation/3/context.json":
                if (!rootNode.has("id")) {
                    logger.error("Manifest JSON does not contain 'id': {}", jsonContent);
                    throw new IllegalArgumentException("Invalid JSON-LD: 'id' is missing");
                }
                if (processForImageImport) {
                    idValue = rootNode.get("id").asText();
                    jsonContext.put("$..items[?(@.type == 'Canvas')]", "_manifest", idValue);
                }
                break;

            default:
                logger.error("Unknown '@context' value: {}", context);
                throw new IllegalArgumentException("Unsupported IIIF manifest version: " + context);
        }

        logger.info("Successfully processed manifest URL: {}", manifest);
        return jsonContext.jsonString();
    }
}
