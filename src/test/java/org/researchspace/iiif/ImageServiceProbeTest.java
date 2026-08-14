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
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * The fallback that fills the measured columns from the manifest claim, used when probing is off or
 * when a manifest exceeds the probe budget. The probe itself needs the network and is exercised by
 * hand against live services, not here.
 *
 * @author Tsz-Kin (Raphael) Chau <chauraph@gmail.com> <tszkin.chau@epfl.ch>
 */
public class ImageServiceProbeTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private ObjectNode row(String service, String claimedProfile) {
        ObjectNode row = MAPPER.createObjectNode();
        row.put("imageservice", service);
        row.put("claimedprofile", claimedProfile);
        return row;
    }

    /**
     * A dead host must be recognised as such, so that a composite manifest pays one timeout for it
     * rather than one per canvas.
     */
    @Test
    public void hostLevelFailuresAreToldApartFromServiceLevelOnes() {
        assertTrue(SafeHttpFetcher.isHostLevel(new SafeHttpFetcher.UnreachableHostException("no dns")));
        assertTrue(SafeHttpFetcher.isHostLevel(new java.io.IOException(new java.net.ConnectException("refused"))));
        assertTrue(SafeHttpFetcher.isHostLevel(new java.net.UnknownHostException("nowhere.example.org")));
        assertFalse(SafeHttpFetcher.isHostLevel(new java.io.IOException("read timed out")));
        assertFalse(SafeHttpFetcher.isHostLevel(new IllegalArgumentException("Only http and https URLs are allowed")));
    }

    @Test
    public void claimOfLevel2IsAccepted() {
        ObjectNode row = row("https://example.org/iiif/x", "http://iiif.io/api/image/2/level2.json");
        ImageServiceProbe.applyClaim(row, ImageServiceProbe.NOT_VERIFIED);
        assertEquals("level2", row.path("level").asText());
        assertTrue(row.path("importable").asBoolean());
        assertEquals("", row.path("blockedreason").asText());
    }

    @Test
    public void claimOfLevel0IsRefusedAndSaysWhy() {
        ObjectNode row = row("https://example.org/iiif/x", "http://iiif.io/api/image/2/level0.json");
        ImageServiceProbe.applyClaim(row, ImageServiceProbe.NOT_VERIFIED);
        assertFalse(row.path("importable").asBoolean());
        assertTrue(row.path("blockedreason").asText().startsWith(ImageServiceProbe.LEVEL_0));
    }

    /** The fallback must never present itself as a measurement. */
    @Test
    public void unverifiedRefusalIsMarkedAsAClaim() {
        ObjectNode row = row("https://example.org/iiif/x", "");
        ImageServiceProbe.applyClaim(row, ImageServiceProbe.NOT_VERIFIED);
        assertTrue(row.path("blockedreason").asText().endsWith(ImageServiceProbe.NOT_VERIFIED));
        assertEquals("", row.path("apiversion").asText());
    }

    @Test
    public void canvasWithoutAServiceIsRefusedWithItsOwnReason() {
        ObjectNode row = row("", "");
        ImageServiceProbe.applyClaim(row, "");
        assertFalse(row.path("importable").asBoolean());
        assertEquals(ImageServiceProbe.NO_SERVICE, row.path("blockedreason").asText());
    }

    /**
     * A row filled from the claim must never look like a measurement, even when the claim accepts
     * it. Without this the UI shows an ordinary Import button for a service nobody checked.
     */
    @Test
    public void claimIsMarkedUnverifiedEvenWhenItAccepts() {
        ObjectNode row = row("https://example.org/iiif/x", "http://iiif.io/api/image/2/level2.json");
        ImageServiceProbe.applyClaim(row, ImageServiceProbe.NOT_VERIFIED);
        assertTrue(row.path("importable").asBoolean());
        assertFalse(row.path("verified").asBoolean());
    }

    /** The template builds the preview URL from quality, so it must always be filled. */
    @Test
    public void qualityIsAlwaysSet() {
        ObjectNode row = row("https://example.org/iiif/x", "http://iiif.io/api/image/2/level1.json");
        ImageServiceProbe.applyClaim(row, "");
        assertEquals("default", row.path("quality").asText());
    }
}
