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

import { EventMaker } from 'platform/api/events';

export interface PyramidalTileSearchEventData {
  // trigger
  /**
   * A search finished and results are on screen. `corpusFingerprint` changes whenever the
   * backend, model or collection size changes, so a listener can detect that the index moved.
   */
  'PyramidalTileSearch.ResultsLoaded': {
    query: string | null;
    queryType: 'text' | 'image';
    backend: string;
    modelName: string;
    corpusFingerprint: string;
    hitCount: number;
  };

  /**
   * The reader opened a hit. `boundingBox` is already in the `xywh=` form that
   * `rs:boundingBox` expects, in full resolution IIIF pixel space.
   *
   * `imageIri` is absent when the IIIF service is not registered in RS. The hit is then
   * display only, and a minting listener must decline rather than mint half a region.
   *
   * `tileId` is the crop the reader chose. `representativeTileId` is the crop deduplication
   * chose. They differ when the reader overrode the automatic pick in the merge inspector,
   * and a minted region should record both.
   */
  'PyramidalTileSearch.HitSelected': {
    iiifService: string;
    imageIri?: string;
    boundingBox: string;
    tileId: string;
    representativeTileId: string;
    similarity: number;
    pyramidLevel: number;
    backend: string;
    modelName: string;
    corpusFingerprint: string;
  };

  /** A search failed. The only channel for a timeout, which a large corpus will produce. */
  'PyramidalTileSearch.SearchFailed': {
    query: string | null;
    queryType: 'text' | 'image';
    error: string;
  };

  // listen
  /** Run a text search from outside the component. */
  'PyramidalTileSearch.Search': {
    query: string;
    backend?: string;
    topK?: number;
  };
}

const event: EventMaker<PyramidalTileSearchEventData> = EventMaker;

export const ResultsLoadedEvent = event('PyramidalTileSearch.ResultsLoaded');
export const HitSelectedEvent = event('PyramidalTileSearch.HitSelected');
export const SearchFailedEvent = event('PyramidalTileSearch.SearchFailed');
export const SearchEvent = event('PyramidalTileSearch.Search');
