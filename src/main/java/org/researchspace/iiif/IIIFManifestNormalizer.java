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

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * Flattens a IIIF Presentation manifest of any version into one row per canvas.
 *
 * This is the only class in the platform that knows about IIIF presentation versions. The SPARQL
 * service descriptor and the Handlebars template consume the flat rows and carry no version logic.
 *
 * Supported input: Presentation API 1 (shared-canvas context), 2, 3 and the 4.0 draft. The v1 and v2
 * structure is `sequences[].canvases[].images[]`; the v3 and v4 structure is
 * `items[](Canvas).items[](AnnotationPage).items[](Annotation).body`. Image services are read as
 * `id` or `@id`, whether the service is a single object or an array, and whether the annotation body
 * is a plain resource or a choice.
 *
 * Row keys are deliberately version-free: manifest, canvasid, label, imageservice, servicetype,
 * claimedprofile. {@link ImageServiceProbe} adds the measured keys.
 *
 * @author Tsz-Kin (Raphael) Chau <chauraph@gmail.com> <tszkin.chau@epfl.ch>
 */
public class IIIFManifestNormalizer {

    public static final String VERSION_1 = "1";
    public static final String VERSION_2 = "2";
    public static final String VERSION_3 = "3";
    public static final String VERSION_4 = "4";

    private static final String SHARED_CANVAS = "shared-canvas.org/ns/context.json";
    private static final String PRESENTATION_2 = "iiif.io/api/presentation/2";
    private static final String PRESENTATION_3 = "iiif.io/api/presentation/3";
    private static final String PRESENTATION_4 = "iiif.io/api/presentation/4";

    private static final JsonNodeFactory FACTORY = JsonNodeFactory.instance;

    /**
     * Reads the presentation version from `@context`, which may be a single string or an array with
     * extension contexts beside the presentation one.
     *
     * @return one of the VERSION_* constants
     * @throws IllegalArgumentException if no known presentation context is present
     */
    public static String detectVersion(JsonNode manifest) {
        JsonNode context = manifest.get("@context");
        if (context == null) {
            throw new IllegalArgumentException("Invalid JSON-LD: '@context' is missing");
        }
        for (String candidate : textValues(context)) {
            if (candidate.contains(SHARED_CANVAS)) {
                return VERSION_1;
            }
            if (candidate.contains(PRESENTATION_2)) {
                return VERSION_2;
            }
            if (candidate.contains(PRESENTATION_3)) {
                return VERSION_3;
            }
            if (candidate.contains(PRESENTATION_4)) {
                return VERSION_4;
            }
        }
        throw new IllegalArgumentException("Unsupported IIIF manifest version, '@context' is " + context.toString());
    }

    /**
     * @return { manifest, version, rows: [ { manifest, canvasid, label, imageservice, servicetype,
     *         claimedprofile } ] }
     */
    public static ObjectNode normalize(JsonNode manifest) {
        String version = detectVersion(manifest);
        String manifestId = text(manifest.get(VERSION_1.equals(version) || VERSION_2.equals(version) ? "@id" : "id"));
        if (manifestId.isEmpty()) {
            // A manifest read from a URL that does not match its own id is still usable; only the
            // provenance link suffers, so this is not fatal.
            manifestId = text(manifest.get("@id"));
        }

        ArrayNode rows = FACTORY.arrayNode();
        List<JsonNode> canvases = VERSION_1.equals(version) || VERSION_2.equals(version)
                ? legacyCanvases(manifest)
                : modernCanvases(manifest);

        for (JsonNode canvas : canvases) {
            boolean legacy = VERSION_1.equals(version) || VERSION_2.equals(version);
            List<JsonNode> services = legacy ? legacyServices(canvas) : modernServices(canvas);
            JsonNode service = services.isEmpty() ? null : services.get(0);

            ObjectNode row = FACTORY.objectNode();
            row.put("manifest", manifestId);
            row.put("manifestversion", version);
            row.put("canvasid", text(canvas.get(legacy ? "@id" : "id")));
            row.put("label", flatten(canvas.get("label")));
            row.put("imageservice", service == null ? "" : serviceId(service));
            row.put("servicetype", service == null ? "" : text(firstOf(service, "type", "@type")));
            row.put("claimedprofile", service == null ? "" : flatten(service.get("profile")));
            rows.add(row);
        }

        ObjectNode result = FACTORY.objectNode();
        result.put("manifest", manifestId);
        result.put("version", version);
        result.set("rows", rows);
        return result;
    }

    /** v1 and v2: sequences[].canvases[] */
    private static List<JsonNode> legacyCanvases(JsonNode manifest) {
        List<JsonNode> canvases = new ArrayList<>();
        for (JsonNode sequence : arrayOf(manifest.get("sequences"))) {
            for (JsonNode canvas : arrayOf(sequence.get("canvases"))) {
                if (canvas.isObject()) {
                    canvases.add(canvas);
                }
            }
        }
        return canvases;
    }

    /**
     * v3 and v4: top level items[] only. Canvases referenced from `structures` are ranges pointing
     * at the same canvases, and including them duplicates every row.
     */
    private static List<JsonNode> modernCanvases(JsonNode manifest) {
        List<JsonNode> canvases = new ArrayList<>();
        for (JsonNode item : arrayOf(manifest.get("items"))) {
            if (item.isObject() && "Canvas".equals(text(item.get("type")))) {
                canvases.add(item);
            }
        }
        return canvases;
    }

    /** v1 and v2: canvas.images[] annotations, resource (or choice), service (object or array). */
    private static List<JsonNode> legacyServices(JsonNode canvas) {
        List<JsonNode> services = new ArrayList<>();
        for (JsonNode annotation : arrayOf(canvas.get("images"))) {
            if (!isPainting(annotation)) {
                continue;
            }
            for (JsonNode body : bodies(annotation.get("resource"))) {
                collectServices(body.get("service"), services);
            }
        }
        return services;
    }

    /** v3 and v4: canvas.items[](AnnotationPage).items[](Annotation).body.service[] */
    private static List<JsonNode> modernServices(JsonNode canvas) {
        List<JsonNode> services = new ArrayList<>();
        for (JsonNode page : arrayOf(canvas.get("items"))) {
            if (!"AnnotationPage".equals(text(page.get("type")))) {
                continue;
            }
            for (JsonNode annotation : arrayOf(page.get("items"))) {
                if (!isPainting(annotation)) {
                    continue;
                }
                for (JsonNode body : bodies(annotation.get("body"))) {
                    collectServices(body.get("service"), services);
                }
            }
        }
        return services;
    }

    /**
     * `motivation` is a string in v2 and v3, an array in the v4 draft, and absent in v2 manifests
     * whose producer relied on `images[]` meaning painting by definition. All three are painting.
     */
    private static boolean isPainting(JsonNode annotation) {
        if (annotation == null || !annotation.isObject()) {
            return false;
        }
        JsonNode motivation = annotation.get("motivation");
        if (motivation == null || motivation.isNull()) {
            return true;
        }
        for (String value : textValues(motivation)) {
            if (value.endsWith("painting")) {
                return true;
            }
        }
        return false;
    }

    /** Unwraps oa:Choice / Choice bodies, which carry the alternatives under default/item/items. */
    private static List<JsonNode> bodies(JsonNode body) {
        List<JsonNode> bodies = new ArrayList<>();
        for (JsonNode candidate : arrayOf(body)) {
            if (!candidate.isObject()) {
                continue;
            }
            String type = text(firstOf(candidate, "type", "@type"));
            if ("Choice".equals(type) || "oa:Choice".equals(type)) {
                bodies.addAll(bodies(candidate.get("default")));
                bodies.addAll(bodies(candidate.get("item")));
                bodies.addAll(bodies(candidate.get("items")));
            } else {
                bodies.add(candidate);
            }
        }
        return bodies;
    }

    /** A service may be a single object or an array, and may nest further services. */
    private static void collectServices(JsonNode service, List<JsonNode> collected) {
        for (JsonNode candidate : arrayOf(service)) {
            if (!candidate.isObject()) {
                continue;
            }
            if (!serviceId(candidate).isEmpty()) {
                collected.add(candidate);
            }
            collectServices(candidate.get("service"), collected);
        }
    }

    /** Image API 1 and 2 services carry `@id`; Image API 3 services carry `id`. */
    private static String serviceId(JsonNode service) {
        return text(firstOf(service, "id", "@id"));
    }

    private static JsonNode firstOf(JsonNode node, String... fields) {
        if (node == null) {
            return null;
        }
        for (String field : fields) {
            JsonNode value = node.get(field);
            if (value != null && !value.isNull()) {
                return value;
            }
        }
        return null;
    }

    /**
     * Reduces a label, a profile or any other repeatable value to one string: a v3 language map to
     * its first entry, an array to its first member, a scalar to itself.
     */
    private static String flatten(JsonNode node) {
        if (node == null || node.isNull()) {
            return "";
        }
        if (node.isValueNode()) {
            return node.asText();
        }
        if (node.isArray()) {
            return node.size() == 0 ? "" : flatten(node.get(0));
        }
        Iterator<String> fields = node.fieldNames();
        while (fields.hasNext()) {
            String field = fields.next();
            if (!"none".equals(field)) {
                return flatten(node.get(field));
            }
        }
        return node.has("none") ? flatten(node.get("none")) : "";
    }

    private static List<String> textValues(JsonNode node) {
        List<String> values = new ArrayList<>();
        for (JsonNode candidate : arrayOf(node)) {
            if (candidate.isValueNode()) {
                values.add(candidate.asText());
            }
        }
        return values;
    }

    /** Treats a missing value as empty, a single value as one element, an array as itself. */
    private static List<JsonNode> arrayOf(JsonNode node) {
        List<JsonNode> values = new ArrayList<>();
        if (node == null || node.isNull()) {
            return values;
        }
        if (node.isArray()) {
            node.forEach(values::add);
        } else {
            values.add(node);
        }
        return values;
    }

    private static String text(JsonNode node) {
        return node == null || node.isNull() ? "" : node.asText();
    }

    private IIIFManifestNormalizer() {
    }
}
