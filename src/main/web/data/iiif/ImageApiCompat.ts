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
 * Image API 3.0 support for the OpenSeadragon 2.3/2.4.1 builds RS ships (Mirador 2's bundled
 * copy and the npm one behind OpenSeadragonOverlay). Both read Image API 1.x/2.x only.
 *
 * A backport of openseadragon#1764 (released in 2.4.2), restricted to 3.0 services so that
 * 1.x and 2.x behave exactly as before:
 *
 * - `id` is aliased to `@id`; without it the IIIFTileSource constructor throws
 *   "IIIF required parameters not provided".
 * - 3.0 `profile` is a string, which 2.x's private `canBeTiled` reads as an array. A level0
 *   service without `sizeByWh` must fall back to the `sizes` pyramid, not arbitrary tiles.
 * - tile sizes are requested as `w,h` (the 3.0 canonical form), or `max` at full size. 2.x
 *   sends `w,`, which a 3.0 level0 server (static tiles on disk) cannot answer.
 *
 * One change applies to every version: when the info.json `@id` is the requested service id
 * with different percent-encoding (Loris answers `…/loris/bbb%2Fbbb-…` for `…/loris/bbb/bbb-…`),
 * tiles are requested under the requested id. Both name the same image on the same server, and
 * the requested id is the one RS stores and builds thumbnails from, so the browser and server
 * caches are shared. Any other `@id` is left alone.
 */

const IMAGE_API_3_CONTEXT = 'http://iiif.io/api/image/3/context.json';
/** Stands in for a 3.0 level0 profile so that OpenSeadragon 2.x's `canBeTiled` returns false. */
const IMAGE_API_2_LEVEL0 = 'http://iiif.io/api/image/2/level0.json';
const IMAGE_API_3_LEVEL0 = [
  'level0',
  'http://iiif.io/api/image/3/level0.json',
  'https://iiif.io/api/image/3/level0.json',
];

export function isImageApi3(info: any): boolean {
  if (!info || typeof info !== 'object') {
    return false;
  }
  const context = info['@context'];
  const contexts: unknown[] = Array.isArray(context) ? context : [context];
  return contexts.indexOf(IMAGE_API_3_CONTEXT) !== -1 || info.type === 'ImageService3';
}

/** Mutates a 3.0 info.json in place into the shape OpenSeadragon 2.x's IIIFTileSource accepts. */
export function normalizeImageApi3Info(info: any) {
  if (!isImageApi3(info)) {
    return;
  }
  if (!info['@id'] && typeof info.id === 'string') {
    info['@id'] = info.id;
  }
  const tiled = info.tiles || info.tile_width || info.tile_height;
  if (!tiled && typeof info.profile === 'string') {
    const level0 = IMAGE_API_3_LEVEL0.indexOf(info.profile) !== -1;
    const sizeByWh = Array.isArray(info.extraFeatures) && info.extraFeatures.indexOf('sizeByWh') !== -1;
    info.profile = [level0 && !sizeByWh ? IMAGE_API_2_LEVEL0 : info.profile];
  }
}

function decodeOrNull(uri: string): string | null {
  try {
    return decodeURIComponent(uri);
  } catch (e) {
    return null;
  }
}

/**
 * Uses the requested service id when `@id` names the same service with different
 * percent-encoding. `url` is the info.json URL OpenSeadragon fetched; it is absent when a
 * caller hands OpenSeadragon an info.json object, and then nothing changes.
 */
export function keepRequestedServiceId(info: any, url?: string) {
  if (!info || typeof info['@id'] !== 'string' || typeof url !== 'string' || !/\/info\.json$/.test(url)) {
    return;
  }
  const requested = url.replace(/\/info\.json$/, '');
  if (requested === info['@id']) {
    return;
  }
  const decoded = decodeOrNull(requested);
  if (decoded !== null && decoded === decodeOrNull(info['@id'])) {
    info['@id'] = requested;
  }
}

/**
 * The 3.0 branch of openseadragon 2.4.2's `IIIFTileSource.getTileUrl`: the same tile geometry
 * as 2.4.1, with `w,h` sizes. `this` is an IIIFTileSource.
 */
function imageApi3TileUrl(this: any, level: number, x: number, y: number): string | null {
  const format = this.tileFormat || 'jpg';
  if (this.emulateLegacyImagePyramid) {
    if (this.levels.length > 0 && level >= this.minLevel && level <= this.maxLevel) {
      const { width, height } = this.levels[level];
      return `${this['@id']}/full/${width},${height}/0/default.${format}`;
    }
    return null;
  }

  const scale = Math.pow(0.5, this.maxLevel - level);
  const levelWidth = Math.ceil(this.width * scale);
  const levelHeight = Math.ceil(this.height * scale);
  const tileWidth = this.getTileWidth(level);
  const tileHeight = this.getTileHeight(level);
  const iiifTileSizeWidth = Math.ceil(tileWidth / scale);
  const iiifTileSizeHeight = Math.ceil(tileHeight / scale);

  let region: string;
  let size: string;
  if (levelWidth < tileWidth && levelHeight < tileHeight) {
    region = 'full';
    size = levelWidth === this.width && levelHeight === this.height ? 'max' : `${levelWidth},${levelHeight}`;
  } else {
    const tileX = x * iiifTileSizeWidth;
    const tileY = y * iiifTileSizeHeight;
    const tileW = Math.min(iiifTileSizeWidth, this.width - tileX);
    const tileH = Math.min(iiifTileSizeHeight, this.height - tileY);
    region =
      x === 0 && y === 0 && tileW === this.width && tileH === this.height
        ? 'full'
        : [tileX, tileY, tileW, tileH].join(',');
    const sizeW = Math.ceil(tileW * scale);
    const sizeH = Math.ceil(tileH * scale);
    size = sizeW === this.width && sizeH === this.height ? 'max' : `${sizeW},${sizeH}`;
  }
  return [this['@id'], region, size, '0', `default.${format}`].join('/');
}

/**
 * Patches `osd.IIIFTileSource` once; later calls on the same OpenSeadragon object are no-ops.
 * Only 3.0 services take the new tile paths.
 */
export function applyTileSourceShim(osd: any) {
  const proto = osd && osd.IIIFTileSource && osd.IIIFTileSource.prototype;
  if (!proto || proto.__imageApi3Shim) {
    return;
  }
  const configure = proto.configure;
  proto.configure = function (data: any, url?: string) {
    normalizeImageApi3Info(data);
    const options = configure.apply(this, arguments);
    keepRequestedServiceId(options, url);
    return options;
  };
  const getTileUrl = proto.getTileUrl;
  proto.getTileUrl = function (level: number, x: number, y: number) {
    return isImageApi3(this) ? imageApi3TileUrl.call(this, level, x, y) : getTileUrl.apply(this, arguments);
  };
  proto.__imageApi3Shim = true;
}
