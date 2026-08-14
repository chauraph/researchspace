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

import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.InetAddress;
import java.net.NoRouteToHostException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.UnknownHostException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Locale;
import java.util.Optional;

/**
 * Fetches a URL that a user supplied.
 *
 * The manifest URL and the image service URL both come from user input and are dereferenced by the
 * server, so this class is the place that decides what the server is allowed to request. It refuses
 * everything that is not plain http or https, refuses hosts that resolve to the machine itself or to
 * a private network, and caps how long it reads and how much it keeps.
 *
 * @author Tsz-Kin (Raphael) Chau <chauraph@gmail.com> <tszkin.chau@epfl.ch>
 */
public class SafeHttpFetcher {

    public static final int MAX_BYTES = 20 * 1024 * 1024;

    /** An info.json is small, and a probe runs inside a shared time budget. */
    public static final int MAX_PROBE_BYTES = 1024 * 1024;
    private static final Duration READ_TIMEOUT = Duration.ofSeconds(20);
    private static final Duration PROBE_READ_TIMEOUT = Duration.ofSeconds(5);

    private static final HttpClient CLIENT = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NORMAL).build();

    /** A separate client so that a dead host costs a probe three seconds, not five. */
    private static final HttpClient PROBE_CLIENT = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3))
            .followRedirects(HttpClient.Redirect.NORMAL).build();

    /**
     * A failure of the host itself: it does not resolve, refuses the connection, or is unroutable.
     * A caller that fetches many URLs from the same host can remember this and stop trying, which a
     * per-URL failure never justifies.
     */
    public static class UnreachableHostException extends IllegalArgumentException {
        private static final long serialVersionUID = 1L;

        public UnreachableHostException(String message) {
            super(message);
        }
    }

    public static class Result {
        public final int status;
        public final String body;
        public final Optional<String> allowOrigin;

        Result(int status, String body, Optional<String> allowOrigin) {
            this.status = status;
            this.body = body;
            this.allowOrigin = allowOrigin;
        }

        public boolean isSuccessful() {
            return status >= 200 && status < 300;
        }
    }

    /**
     * @throws IllegalArgumentException if the URL is malformed or the policy refuses it
     * @throws IOException              if the request fails
     */
    public static Result get(String url) throws IOException {
        return get(url, CLIENT, READ_TIMEOUT, MAX_BYTES);
    }

    /**
     * A short, small read for an info.json. Use this when many URLs are fetched under one budget, so
     * that one slow or dead service cannot consume it.
     */
    public static Result getSmall(String url) throws IOException {
        return get(url, PROBE_CLIENT, PROBE_READ_TIMEOUT, MAX_PROBE_BYTES);
    }

    private static Result get(String url, HttpClient client, Duration readTimeout, int maxBytes) throws IOException {
        URI uri = validate(url);
        HttpRequest request = HttpRequest.newBuilder(uri).timeout(readTimeout).header("Accept", "application/json")
                .GET().build();
        HttpResponse<InputStream> response;
        try {
            response = client.send(request, HttpResponse.BodyHandlers.ofInputStream());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Request interrupted: " + uri, e);
        }
        try (InputStream stream = response.body()) {
            byte[] bytes = stream.readNBytes(maxBytes);
            String body = new String(bytes, StandardCharsets.UTF_8);
            return new Result(response.statusCode(), body,
                    response.headers().firstValue("access-control-allow-origin"));
        }
    }

    /**
     * Whether a failure is a property of the host rather than of the one URL: no DNS entry, refused
     * connection, no route, or a connect timeout.
     */
    public static boolean isHostLevel(Throwable error) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof UnreachableHostException || cause instanceof UnknownHostException
                    || cause instanceof ConnectException || cause instanceof NoRouteToHostException
                    || cause instanceof HttpConnectTimeoutException) {
                return true;
            }
            if (cause.getCause() == cause) {
                break;
            }
        }
        return false;
    }

    /**
     * Applies the request policy. Public so that a caller can reject a URL before it decides to
     * fetch it at all.
     */
    public static URI validate(String url) {
        URI uri;
        try {
            uri = new URI(url);
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("Not a valid URL: " + url);
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            throw new IllegalArgumentException("Only http and https URLs are allowed, got: " + scheme);
        }
        String host = uri.getHost();
        if (host == null || host.isEmpty()) {
            throw new IllegalArgumentException("URL has no host: " + url);
        }
        InetAddress[] addresses;
        try {
            addresses = InetAddress.getAllByName(host);
        } catch (UnknownHostException e) {
            throw new UnreachableHostException("Host does not resolve: " + host);
        }
        for (InetAddress address : addresses) {
            if (address.isLoopbackAddress() || address.isAnyLocalAddress() || address.isLinkLocalAddress()
                    || address.isSiteLocalAddress() || address.isMulticastAddress()) {
                throw new IllegalArgumentException("Refusing to fetch an address on this network: " + host);
            }
        }
        return uri;
    }

    private SafeHttpFetcher() {
    }
}
