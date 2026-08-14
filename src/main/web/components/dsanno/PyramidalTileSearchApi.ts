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

/**
 * Typed client for the pyramidal tile search service.
 *
 * Every request goes through the platform proxy (`/proxy/<id>/...`), never straight to the
 * service. The service sends no CORS headers, so a direct browser call is blocked; the proxy
 * also puts the service behind the Shiro permission `proxy:<id>`.
 */

export interface DedupInfo {
  merged: boolean;
  group_size: number;
  suppressed_count: number;
  merged_ids: string[];
  representative_id?: string;
  method?: string;
  preview_bounds?: { x: number; y: number; w: number; h: number };
  preview_tiles?: PreviewTile[];
}

/**
 * One candidate in a merge group. `x/y/w/h` are normalised inside `preview_bounds`, which is
 * what lets every candidate be drawn over a single context crop instead of fetched separately.
 */
export interface PreviewTile {
  id: string;
  pyramid_level: number;
  similarity: number;
  representative: boolean;
  gx: number;
  gy: number;
  gw: number;
  gh: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SearchHit {
  id: string;
  similarity: number;
  distance: number;
  /** Full resolution IIIF pixel space. No conversion is needed to build a region request. */
  global_x: number;
  global_y: number;
  global_w: number;
  global_h: number;
  row?: number;
  col?: number;
  tile_size?: number;
  pyramid_level?: number;
  job_id?: number;
  lift_width?: number;
  lift_height?: number;
  dedup?: DedupInfo;
}

export interface SearchResponse {
  success: boolean;
  backend: string;
  query_type: 'text' | 'image';
  query?: string;
  collection: string;
  model_name?: string;
  corpus_fingerprint?: string;
  results: SearchHit[];
  filter_info?: string;
  timings: { encode_time: number; search_time: number };
  postprocess?: {
    raw_candidates?: number;
    after_spatial_merge?: number;
    returned_results?: number;
    spatial_suppressed_total?: number;
    effective_preset?: string;
    spatial_dedup_method?: string;
  };
}

export interface BackendInfo {
  label?: string;
  model_name?: string;
  collection_name?: string;
}

export interface Capabilities {
  version: string;
  fingerprint: string;
  backends: { [id: string]: BackendInfo };
  default_backend_for_query_type: { text?: string; image?: string };
  /** Loaded and warm right now. Backends load lazily, so this is not what drives affordances. */
  query_type_backend_lists: { text: string[]; image: string[] };
  /** Configured for this deployment. Drive the mode toggle and the backend list from this. */
  configured_query_type_backend_lists: { text: string[]; image: string[] };
  corpus: {
    collection_name?: string;
    total_tiles?: number;
    pyramid_levels: number[];
    tile_sizes: number[];
    lift_width?: number;
    lift_height?: number;
    iiif_prefix?: string;
  };
  dedup: {
    default_preset?: string;
    /**
     * The method the server actually applies. Initialise a control from this, not from
     * `defaults.spatial_dedup_method`, which is a property of the named preset.
     */
    default_spatial_dedup_method?: string;
    presets?: { [id: string]: { label?: string; description?: string } };
  };
}

export interface SearchParams {
  topK: number;
  backend?: string;
  pyramidLevels?: number[];
  tileSize?: number;
  dedupPreset?: string;
}

export class TileSearchClient {
  constructor(private readonly proxyPath: string) {}

  private url(path: string): string {
    return `${this.proxyPath.replace(/\/$/, '')}/${path}`;
  }

  private async json<T>(response: Response): Promise<T> {
    if (!response.ok) {
      // The proxy answers 403 when the Shiro permission is missing, which is the most
      // likely misconfiguration. Say so instead of reporting a bare status code.
      if (response.status === 403) {
        throw new Error(
          'Access to the tile search service was refused. The role needs the ' +
            'permission proxy:tile-search in shiro.ini.'
        );
      }
      const body = await response.text().catch(() => '');
      throw new Error(`Tile search service returned ${response.status}. ${body}`.trim());
    }
    return response.json() as Promise<T>;
  }

  capabilities(): Promise<Capabilities> {
    return fetch(this.url('capabilities'), { credentials: 'same-origin' }).then((r) =>
      this.json<Capabilities>(r)
    );
  }

  searchByText(query: string, params: SearchParams, signal?: AbortSignal): Promise<SearchResponse> {
    return fetch(this.url('search'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        query,
        top_k: Number(params.topK),
        backend: params.backend,
        pyramid_levels: params.pyramidLevels && params.pyramidLevels.length ? params.pyramidLevels : null,
        tile_size: params.tileSize,
        dedup_preset: params.dedupPreset,
      }),
    }).then((r) => this.json<SearchResponse>(r));
  }

  searchByImage(file: File, params: SearchParams, signal?: AbortSignal): Promise<SearchResponse> {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('top_k', String(Number(params.topK)));
    if (params.backend) {
      form.append('backend', params.backend);
    }
    if (params.pyramidLevels && params.pyramidLevels.length) {
      // This endpoint takes a string, because multipart form fields carry no types.
      form.append('pyramid_levels', JSON.stringify(params.pyramidLevels));
    }
    if (params.tileSize) {
      form.append('tile_size', String(params.tileSize));
    }
    if (params.dedupPreset) {
      form.append('dedup_preset', params.dedupPreset);
    }
    // Do not set Content-Type. The browser must add the multipart boundary itself.
    return fetch(this.url('search-image'), {
      method: 'POST',
      credentials: 'same-origin',
      signal,
      body: form,
    }).then((r) => this.json<SearchResponse>(r));
  }
}

/** Build a IIIF region request from a hit. The service never needs to know the public host. */
export function tileUrl(
  iiifService: string,
  region: { global_x: number; global_y: number; global_w: number; global_h: number },
  size = 320
): string {
  const base = iiifService.replace(/\/$/, '');
  return `${base}/${region.global_x},${region.global_y},${region.global_w},${region.global_h}/${size},/0/default.jpg`;
}

/** The literal that `rs:boundingBox` expects. */
export function boundingBox(region: {
  global_x: number;
  global_y: number;
  global_w: number;
  global_h: number;
}): string {
  return `xywh=${region.global_x},${region.global_y},${region.global_w},${region.global_h}`;
}
