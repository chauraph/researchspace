/**
 * ResearchSpace
 * Copyright (C) 2026, Tsz Kin Chau, eM+ / EPFL
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

package org.researchspace.iiif;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * Measures what an image service can actually do, instead of trusting what the manifest claims
 * about it.
 *
 * The claim is unreliable in both directions: the manifests of the Bodleian and of Wellcome declare
 * level1 for services whose own info.json declares level2, and a service that declares level0 may
 * still answer region requests.
 *
 * Every service is probed on its own. Caching one verdict per host would be faster, but one host can
 * serve services of different capability - Wellcome serves level2 under /image/ and level0 under
 * /thumbs/ - so a shared verdict can enable an import that cannot work, or block one that can. The
 * probes run in parallel and are deduplicated by service URL, which costs about 2.4 s for a
 * 210 canvas manifest against a server answering in 72 ms.
 *
 * A manifest is a composite by design: the presentation API states that "the existence of an HTTP(S)
 * URI in the id property does not mean that the URI will always be dereferencable", and one manifest
 * may gather content from several owners. A dead service is therefore ordinary, not exceptional. The
 * probe refuses it with a reason, and remembers the failure per host when the host itself is dead, so
 * that one unreachable owner costs one timeout rather than one per canvas.
 *
 * Past {@link #MAX_SERVICES} or past the time budget, the remaining rows fall back to the profile
 * the manifest claims and say so in blockedreason. The fallback never claims to be a measurement.
 *
 * @author Tsz-Kin (Raphael) Chau <chauraph@gmail.com> <tszkin.chau@epfl.ch>
 */
public class ImageServiceProbe {

    private static final Logger logger = LogManager.getLogger(ImageServiceProbe.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** Above this many distinct services in one manifest, the rest fall back to the claim. */
    public static final int MAX_SERVICES = 500;
    private static final int THREADS = 8;
    private static final long BUDGET_SECONDS = 30;

    static final String NO_SERVICE = "This canvas has no IIIF image service";
    static final String NOT_ABSOLUTE = "Image service is not an absolute http(s) URL";
    static final String UNREACHABLE = "Image service did not answer";
    static final String NO_CORS = "Image service sends no CORS header, the viewer cannot read it";
    static final String LEVEL_0 = "Level 0 service, regions cannot be cropped";
    static final String LEVEL_UNKNOWN = "Image service declares no compliance level";
    static final String API_1 = "Image API 1.x is not supported by the ResearchSpace image URLs";
    public static final String NOT_VERIFIED = " (claimed by the manifest, not verified)";

    private final Map<String, ObjectNode> byService = new ConcurrentHashMap<>();
    private final Map<String, String> deadHosts = new ConcurrentHashMap<>();

    /**
     * Adds apiversion, level, quality, importable and blockedreason to every row produced by
     * {@link IIIFManifestNormalizer}.
     */
    public void enrichAll(ArrayNode rows) {
        Set<String> services = new LinkedHashSet<>();
        for (JsonNode row : rows) {
            String service = row.path("imageservice").asText("");
            if (!service.isEmpty()) {
                services.add(service);
            }
        }

        List<String> probed = new ArrayList<>(services);
        if (probed.size() > MAX_SERVICES) {
            logger.info("Manifest holds {} distinct image services, probing the first {}", probed.size(),
                    MAX_SERVICES);
            probed = probed.subList(0, MAX_SERVICES);
        }
        probeInParallel(probed);

        for (JsonNode row : rows) {
            ObjectNode target = (ObjectNode) row;
            String service = target.path("imageservice").asText("");
            ObjectNode measured = byService.get(service);
            if (measured != null) {
                target.setAll(measured);
            } else {
                applyClaim(target, service.isEmpty() ? "" : NOT_VERIFIED);
            }
        }
    }

    private void probeInParallel(List<String> services) {
        if (services.isEmpty()) {
            return;
        }
        ExecutorService pool = Executors.newFixedThreadPool(Math.min(THREADS, services.size()));
        try {
            List<Callable<Void>> tasks = new ArrayList<>(services.size());
            for (String service : services) {
                tasks.add(() -> {
                    try {
                        byService.put(service, measure(service));
                    } catch (Throwable unexpected) {
                        // A row without a verdict falls back to the claim, which is worse than an
                        // honest refusal, so never let a task end without recording one.
                        logger.warn("Image service probe threw for {}", service, unexpected);
                        byService.put(service, blocked(UNREACHABLE));
                    }
                    return null;
                });
            }
            pool.invokeAll(tasks, BUDGET_SECONDS, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            logger.warn("Image service probing was interrupted");
        } finally {
            pool.shutdownNow();
        }
    }

    private ObjectNode measure(String service) {
        String host;
        try {
            host = SafeHttpFetcher.validate(service).getHost();
        } catch (Exception e) {
            // A host that does not resolve is dead for every service on it, and the manifest may
            // hold hundreds. Remember it rather than paying the DNS timeout again.
            if (SafeHttpFetcher.isHostLevel(e)) {
                return rememberDeadHost(hostOf(service), UNREACHABLE);
            }
            return blocked(NOT_ABSOLUTE);
        }
        String deadReason = deadHosts.get(host);
        if (deadReason != null) {
            return blocked(deadReason);
        }

        SafeHttpFetcher.Result response;
        try {
            response = SafeHttpFetcher.getSmall(stripTrailingSlash(service) + "/info.json");
        } catch (Exception e) {
            logger.info("Image service probe failed for {}: {}", service, e.getMessage());
            if (SafeHttpFetcher.isHostLevel(e)) {
                return rememberDeadHost(host, UNREACHABLE);
            }
            return blocked(UNREACHABLE);
        }
        if (!response.isSuccessful()) {
            return blocked(UNREACHABLE + " (HTTP " + response.status + ")");
        }
        if (!response.allowOrigin.isPresent()) {
            return blocked(NO_CORS);
        }
        JsonNode info;
        try {
            info = MAPPER.readTree(response.body);
        } catch (Exception e) {
            return blocked(UNREACHABLE + " (info.json is not JSON)");
        }

        String apiVersion = apiVersion(info);
        String level = level(info);
        ObjectNode measured = MAPPER.createObjectNode();
        measured.put("apiversion", apiVersion);
        measured.put("level", level);
        measured.put("quality", "1.1".equals(apiVersion) ? "native" : "default");

        if ("level0".equals(level)) {
            return blocked(measured, LEVEL_0);
        }
        if ("unknown".equals(level)) {
            return blocked(measured, LEVEL_UNKNOWN);
        }
        if ("1.1".equals(apiVersion)) {
            // Mirador renders Image API 1.x correctly, but every other ResearchSpace surface builds
            // `.../default.jpg`, which a 1.x service answers with HTTP 400.
            return blocked(measured, API_1);
        }
        measured.put("importable", true);
        measured.put("blockedreason", "");
        measured.put("verified", true);
        return measured;
    }

    /**
     * Fills the measured columns from what the manifest claims. Used when probing is switched off,
     * and for the rows left over when a manifest exceeds the probe budget.
     */
    public static void applyClaim(ObjectNode row, String note) {
        String service = row.path("imageservice").asText("");
        String claimed = row.path("claimedprofile").asText("");
        row.put("verified", false);
        if (service.isEmpty()) {
            row.put("apiversion", "");
            row.put("level", "");
            row.put("quality", "default");
            row.put("importable", false);
            row.put("blockedreason", NO_SERVICE);
            return;
        }
        String level = claimed.contains("level2") ? "level2"
                : claimed.contains("level1") ? "level1" : claimed.contains("level0") ? "level0" : "unknown";
        row.put("apiversion", "");
        row.put("level", level);
        row.put("quality", "default");
        boolean usable = "level1".equals(level) || "level2".equals(level);
        row.put("importable", usable);
        row.put("blockedreason",
                usable ? "" : ("level0".equals(level) ? LEVEL_0 : LEVEL_UNKNOWN) + note);
    }

    /** Image API 3 declares `type` ImageService3; 1.x and 2 are told apart by their context. */
    private static String apiVersion(JsonNode info) {
        String context = info.path("@context").isArray() ? info.path("@context").toString()
                : info.path("@context").asText("");
        if ("ImageService3".equals(info.path("type").asText("")) || context.contains("api/image/3")) {
            return "3.0";
        }
        if (context.contains("api/image/2")) {
            return "2.0";
        }
        if (context.contains("image-api/1.1") || context.contains("api/image/1")) {
            return "1.1";
        }
        return "unknown";
    }

    /** The profile is a string in Image API 3, and a string or an array in 1.x and 2. */
    private static String level(JsonNode info) {
        String profile = info.path("profile").toString();
        if (profile.contains("level2")) {
            return "level2";
        }
        if (profile.contains("level1")) {
            return "level1";
        }
        if (profile.contains("level0")) {
            return "level0";
        }
        return "unknown";
    }

    /**
     * Only transport failures are remembered per host, never a capability verdict: one host can
     * serve level2 and level0 services side by side, but a host that refuses connections refuses
     * them for every service on it.
     */
    private ObjectNode rememberDeadHost(String host, String reason) {
        if (host != null && !host.isEmpty()) {
            deadHosts.putIfAbsent(host, reason);
        }
        return blocked(reason);
    }

    private static String hostOf(String url) {
        try {
            return new URI(url).getHost();
        } catch (URISyntaxException e) {
            return "";
        }
    }

    private static String stripTrailingSlash(String url) {
        return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
    }

    private static ObjectNode blocked(String reason) {
        return blocked(MAPPER.createObjectNode(), reason);
    }

    private static ObjectNode blocked(ObjectNode measured, String reason) {
        measured.put("apiversion", measured.path("apiversion").asText(""));
        measured.put("level", measured.path("level").asText(""));
        measured.put("quality", measured.path("quality").asText("default"));
        measured.put("importable", false);
        measured.put("blockedreason", reason);
        measured.put("verified", true);
        return measured;
    }
}
