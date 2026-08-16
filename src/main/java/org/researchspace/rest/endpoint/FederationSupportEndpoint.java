/**
 * ResearchSpace
 * Copyright (C) 2024, Tsz Kin Chau, eM+ / EPFL
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

package org.researchspace.rest.endpoint;

import static javax.ws.rs.core.MediaType.APPLICATION_JSON;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.researchspace.iiif.IIIFManifestNormalizer;
import org.researchspace.iiif.ImageServiceProbe;
import org.researchspace.iiif.SafeHttpFetcher;
import org.researchspace.rest.feature.CacheControl.NoCache;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import javax.servlet.http.HttpServletRequest;
import javax.ws.rs.DefaultValue;
import javax.ws.rs.GET;
import javax.ws.rs.Path;
import javax.ws.rs.Produces;
import javax.ws.rs.QueryParam;
import javax.ws.rs.core.Context;
import javax.ws.rs.core.UriInfo;

import java.io.IOException;

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
     * Proxy service that passes a IIIF manifest to the Ephedra Federation client, accessible only
     * from localhost.
     *
     * When processForImageImport = true it returns one flat row per canvas instead of the manifest,
     * so that the SPARQL service descriptor and the Handlebars template carry no IIIF version logic.
     * See IIIFManifestNormalizer for the supported versions and ImageServiceProbe for the measured
     * columns.
     */
    @GET()
    @NoCache
    @Path("iiifProxy")
    @Produces(APPLICATION_JSON)
    public String iiifProxy(@QueryParam("manifest") String manifest,
                            @QueryParam("processForImageImport") boolean processForImageImport,
                            @QueryParam("probe") @DefaultValue("true") boolean probeServices) throws Exception {

        logger.info("Received manifest URL: {}", manifest);

        String clientIp = request.getRemoteAddr();

        // Todo: implement proper javax filter
        if (!clientIp.equals("127.0.0.1") && !clientIp.equals("::1")) {
            logger.error("Unauthorized access attempt from IP: {}", clientIp);
            throw new SecurityException("Access denied: Only localhost is allowed to access this endpoint.");
        }

        // The manifest URL is user input, so the fetch policy lives in SafeHttpFetcher.
        SafeHttpFetcher.Result response;
        try {
            response = SafeHttpFetcher.get(manifest);
        } catch (IllegalArgumentException e) {
            logger.error("Refused manifest URL {}: {}", manifest, e.getMessage());
            throw e;
        } catch (IOException e) {
            logger.error("IO error while fetching manifest: {}", manifest, e);
            throw new RuntimeException("Failed to fetch manifest due to IO error", e);
        }
        if (!response.isSuccessful()) {
            throw new RuntimeException("Manifest request failed with HTTP status " + response.status);
        }

        JsonNode manifestNode;
        try {
            manifestNode = new ObjectMapper().readTree(response.body);
        } catch (Exception e) {
            logger.error("Manifest content is not valid JSON: {}", manifest);
            throw new IllegalArgumentException("Manifest is not a valid JSON file", e);
        }

        if (!processForImageImport) {
            return response.body;
        }

        ObjectNode normalized = IIIFManifestNormalizer.normalize(manifestNode);
        if (probeServices) {
            new ImageServiceProbe().enrichAll(normalized.withArray("rows"));
        } else {
            normalized.withArray("rows").forEach(row -> ImageServiceProbe.applyClaim((ObjectNode) row,
                    ImageServiceProbe.NOT_VERIFIED));
        }

        logger.info("Normalized manifest {} (IIIF presentation {}) into {} canvas rows", manifest,
                normalized.path("version").asText(), normalized.withArray("rows").size());
        return normalized.toString();
    }
}
