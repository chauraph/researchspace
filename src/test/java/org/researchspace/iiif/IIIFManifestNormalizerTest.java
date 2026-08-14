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

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.InputStream;

import org.junit.Test;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * Every case here is a manifest shape that broke, or nearly broke, the JSONPath extraction it
 * replaced. The corpus is real: IIIF cookbook recipes, Wellcome, the Bodleian, the Presentation 1.0
 * specification example and the 4.0 draft example, plus hand-made variants for the shapes that no
 * public manifest happened to exercise.
 *
 * @author Tsz-Kin (Raphael) Chau <chauraph@gmail.com> <tszkin.chau@epfl.ch>
 */
public class IIIFManifestNormalizerTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private ObjectNode normalize(String fixture) throws Exception {
        try (InputStream in = getClass().getResourceAsStream("/org/researchspace/iiif/manifests/" + fixture)) {
            assertTrue("missing fixture " + fixture, in != null);
            return IIIFManifestNormalizer.normalize(MAPPER.readTree(in));
        }
    }

    private JsonNode firstRow(String fixture) throws Exception {
        return normalize(fixture).withArray("rows").get(0);
    }

    private int rowCount(String fixture) throws Exception {
        return normalize(fixture).withArray("rows").size();
    }

    // --- version detection ---------------------------------------------------------------------

    @Test
    public void detectsPresentation1SharedCanvas() throws Exception {
        assertEquals("1", normalize("v1_synthetic_spec10.json").path("version").asText());
    }

    @Test
    public void detectsPresentation2() throws Exception {
        assertEquals("2", normalize("v2_bodleian.json").path("version").asText());
    }

    @Test
    public void detectsPresentation3() throws Exception {
        assertEquals("3", normalize("v3_cookbook_0005_imageservice.json").path("version").asText());
    }

    @Test
    public void detectsPresentation4Draft() throws Exception {
        assertEquals("4", normalize("v4_spec_usecase1.json").path("version").asText());
    }

    /** An array @context is legal and common: search and extension contexts sit beside it. */
    @Test
    public void detectsVersionWhenContextIsAnArray() throws Exception {
        assertEquals("3", normalize("v3_wellcome.json").path("version").asText());
        assertEquals("3", normalize("v3_variant_context_array.json").path("version").asText());
    }

    // --- image services ------------------------------------------------------------------------

    @Test
    public void readsImageService2FromPresentation2() throws Exception {
        JsonNode row = firstRow("v2_bodleian.json");
        assertEquals("https://iiif.bodleian.ox.ac.uk/iiif/image/e58b8c60-005c-4c41-a22f-07d49cb25ede",
                row.path("imageservice").asText());
    }

    /** Image API 3 services carry `id`, not `@id`. */
    @Test
    public void readsImageService3FromPresentation3() throws Exception {
        assertEquals("https://iiif.io/api/image/3.0/example/reference/918ecd18c2592080851777620de9bcb5-gottingen",
                firstRow("v3_cookbook_0005_imageservice.json").path("imageservice").asText());
    }

    /** The service version does not have to match the manifest version. Both crossings must work. */
    @Test
    public void readsImageService2InsideAPresentation3Manifest() throws Exception {
        JsonNode row = firstRow("v3_wellcome.json");
        assertEquals("https://iiif.wellcomecollection.org/image/b18035723_0001.JP2", row.path("imageservice").asText());
        assertEquals("ImageService2", row.path("servicetype").asText());
    }

    @Test
    public void readsImageService3InsideAPresentation2Manifest() throws Exception {
        JsonNode row = firstRow("v2_variant_imageservice3.json");
        assertEquals("https://iiif.io/api/image/3.0/example/reference/918ecd18c2592080851777620de9bcb5-gottingen",
                row.path("imageservice").asText());
    }

    @Test
    public void readsServiceWhenItIsAnArray() throws Exception {
        assertEquals("https://iiif.bodleian.ox.ac.uk/iiif/image/e58b8c60-005c-4c41-a22f-07d49cb25ede",
                firstRow("v2_variant_service_array.json").path("imageservice").asText());
    }

    /** oa:Choice bodies: the default alternative comes first. */
    @Test
    public void readsServiceFromAChoiceBody() throws Exception {
        assertEquals("https://iiif.bodleian.ox.ac.uk/iiif/image/e58b8c60-005c-4c41-a22f-07d49cb25ede",
                firstRow("v2_variant_choice.json").path("imageservice").asText());
    }

    @Test
    public void readsServiceFromAPresentation3ChoiceBody() throws Exception {
        assertTrue(firstRow("v3_cookbook_0033_choice.json").path("imageservice").asText().startsWith("https://"));
    }

    // --- annotation shapes ---------------------------------------------------------------------

    /** The 4.0 draft writes `"motivation": ["painting"]`. */
    @Test
    public void acceptsMotivationAsAnArray() throws Exception {
        assertEquals("https://iiif.io/api/image/3.0/example/reference/421e65be2ce95439b3ad6ef1f2ab87a9-dee-natural",
                firstRow("v4_spec_usecase1.json").path("imageservice").asText());
    }

    /** Some v2 producers omit it, because `images[]` means painting by definition. */
    @Test
    public void acceptsAnnotationWithoutMotivation() throws Exception {
        assertEquals("https://iiif.bodleian.ox.ac.uk/iiif/image/e58b8c60-005c-4c41-a22f-07d49cb25ede",
                firstRow("v2_variant_no_motivation.json").path("imageservice").asText());
    }

    // --- canvases ------------------------------------------------------------------------------

    /**
     * Canvases referenced from `structures` are ranges pointing at the same canvases. Counting them
     * as rows shows every canvas twice, the duplicate carrying no image service.
     */
    @Test
    public void ignoresCanvasesReferencedFromStructures() throws Exception {
        // the cookbook recipe references all six of its canvases from ranges
        assertEquals(6, rowCount("v3_cookbook_0024_ranges.json"));
        // the trimmed Wellcome manifest keeps two canvases and one range that repeats one of them
        assertEquals(2, rowCount("v3_wellcome.json"));
    }

    /** A canvas with no image service is still a row, so the template can say why it is blocked. */
    @Test
    public void keepsCanvasesThatHaveNoImageService() throws Exception {
        assertEquals(1, rowCount("v3_cookbook_0001_extimage.json"));
        assertEquals("", firstRow("v3_cookbook_0001_extimage.json").path("imageservice").asText());
        assertEquals(1, rowCount("v3_cookbook_0002_audio.json"));
        assertEquals("", firstRow("v3_cookbook_0002_audio.json").path("imageservice").asText());
    }

    // --- labels and profiles -------------------------------------------------------------------

    /** A v3 label is a language map, a v2 label may be a string or an array. All become a string. */
    @Test
    public void flattensLabelsOfEveryVersion() throws Exception {
        assertEquals("Canvas with a single IIIF image", firstRow("v3_cookbook_0005_imageservice.json").path("label").asText());
        assertEquals("p. 1", firstRow("v1_synthetic_spec10.json").path("label").asText());
        // the Bodleian writes bracketed folio labels, and the brackets are part of the string
        assertEquals("[f. 1 Krishna and his lover Radha seated face-to-face]",
                firstRow("v2_bodleian.json").path("label").asText());
    }

    @Test
    public void flattensProfileWhenItIsAnArray() throws Exception {
        assertEquals("http://iiif.io/api/image/2/level2.json",
                firstRow("v2_variant_profile_array.json").path("claimedprofile").asText());
    }

    // --- provenance ----------------------------------------------------------------------------

    @Test
    public void carriesTheManifestIdOnEveryRow() throws Exception {
        ObjectNode normalized = normalize("v2_wellcome.json");
        String manifest = normalized.path("manifest").asText();
        assertEquals("https://iiif.wellcomecollection.org/presentation/v2/b18035723", manifest);
        normalized.withArray("rows").forEach(row -> assertEquals(manifest, row.path("manifest").asText()));
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsAJsonDocumentThatIsNotAManifest() throws Exception {
        IIIFManifestNormalizer.normalize(MAPPER.readTree("{\"hello\":\"world\"}"));
    }
}
