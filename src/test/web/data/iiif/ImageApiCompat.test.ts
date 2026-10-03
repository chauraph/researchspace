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

import { expect } from 'chai';
import * as OpenSeadragon from 'openseadragon';

import { applyTileSourceShim } from 'platform/data/iiif/ImageApiCompat';

/*
 * Both OpenSeadragon builds RS ships, each evaluated into a fresh, private copy so that a test can
 * compare an unshimmed copy with a shimmed one, and nothing leaks into `window` or into the npm
 * module that OpenSeadragonOverlay shares:
 * - npm openseadragon 2.3.1 (OpenSeadragonOverlay);
 * - the 2.4.1 vendored into Mirador 2 (lib/mirador-src/vendors, built into lib/mirador/mirador.js),
 *   which is what renders external IIIF images in RS. That file also carries d3 after
 *   OpenSeadragon; only the first UMD export is kept.
 */
const BUILDS: { [version: string]: string } = {
  '2.3.1': require('!!raw-loader!openseadragon/build/openseadragon/openseadragon.js').default,
  '2.4.1': require('!!raw-loader!platform/lib/mirador-src/vendors/07-openseadragon.js').default,
};

function loadOpenSeadragon(source: string): any {
  let osd: any;
  const fakeModule = {
    get exports() {
      return {};
    },
    set exports(value: any) {
      osd = osd || value;
    },
  };
  new Function('module', 'define', source)(fakeModule, undefined);
  return osd;
}

const ID = 'https://example.org/iiif/img';
const V1 = 'http://library.stanford.edu/iiif/image-api/1.1/context.json';
const V2 = 'http://iiif.io/api/image/2/context.json';
const V3 = 'http://iiif.io/api/image/3/context.json';
const PROTOCOL = 'http://iiif.io/api/image';
const sizes = [
  { width: 152, height: 203 },
  { width: 609, height: 812 },
  { width: 2436, height: 3248 },
];

/** Image API 1.1 and 2.x shapes; the shim must leave every tile URL of these unchanged. */
const LEGACY: { [name: string]: object } = {
  '1.1 tiled': {
    '@context': V1,
    '@id': ID,
    width: 4872,
    height: 6496,
    scale_factors: [1, 2, 4, 8, 16, 32],
    tile_width: 256,
    tile_height: 256,
    profile: 'http://library.stanford.edu/iiif/image-api/1.1/compliance.html#level2',
  },
  '2.x level2, square tiles': {
    '@context': V2,
    '@id': ID,
    protocol: PROTOCOL,
    width: 4872,
    height: 6496,
    sizes,
    tiles: [{ width: 256, scaleFactors: [1, 2, 4, 8, 16, 32] }],
    profile: ['http://iiif.io/api/image/2/level2.json'],
  },
  '2.x Loris (1024 tiles, full size listed)': {
    '@context': V2,
    '@id': ID,
    protocol: PROTOCOL,
    width: 4872,
    height: 6496,
    sizes: [...sizes, { width: 4872, height: 6496 }],
    tiles: [{ width: 1024, scaleFactors: [1, 2, 4, 8, 16, 32] }],
    profile: ['http://iiif.io/api/image/2/level2.json', { supports: ['sizeByW'] }],
  },
  '2.x level2, no tiles': {
    '@context': V2,
    '@id': ID,
    protocol: PROTOCOL,
    width: 1500,
    height: 1000,
    profile: ['http://iiif.io/api/image/2/level2.json'],
  },
  '2.x two tile sizes': {
    '@context': V2,
    '@id': ID,
    protocol: PROTOCOL,
    width: 4872,
    height: 6496,
    tiles: [
      { width: 512, scaleFactors: [1, 2] },
      { width: 256, height: 512, scaleFactors: [4, 8, 16] },
    ],
    profile: ['http://iiif.io/api/image/2/level2.json'],
  },
  '2.x level0 sizes pyramid': {
    '@context': V2,
    '@id': ID,
    protocol: PROTOCOL,
    width: 4872,
    height: 6496,
    sizes,
    profile: ['http://iiif.io/api/image/2/level0.json'],
  },
  '2.x image smaller than one tile': {
    '@context': V2,
    '@id': ID,
    protocol: PROTOCOL,
    width: 180,
    height: 120,
    tiles: [{ width: 256, scaleFactors: [1, 2, 4] }],
    profile: ['http://iiif.io/api/image/2/level2.json'],
  },
};

/** The files `vips dzsave --layout iiif3` wrote for a 2806×1984 image with 512 px tiles. */
const STATIC_PYRAMID = [
  '0,0,1024,1024/512,512/0/default.jpg',
  '0,0,2048,1984/512,496/0/default.jpg',
  '0,0,512,512/512,512/0/default.jpg',
  '0,1024,1024,960/512,480/0/default.jpg',
  '0,1024,512,512/512,512/0/default.jpg',
  '0,1536,512,448/512,448/0/default.jpg',
  '0,512,512,512/512,512/0/default.jpg',
  '1024,0,1024,1024/512,512/0/default.jpg',
  '1024,0,512,512/512,512/0/default.jpg',
  '1024,1024,1024,960/512,480/0/default.jpg',
  '1024,1024,512,512/512,512/0/default.jpg',
  '1024,1536,512,448/512,448/0/default.jpg',
  '1024,512,512,512/512,512/0/default.jpg',
  '1536,0,512,512/512,512/0/default.jpg',
  '1536,1024,512,512/512,512/0/default.jpg',
  '1536,1536,512,448/512,448/0/default.jpg',
  '1536,512,512,512/512,512/0/default.jpg',
  '2048,0,512,512/512,512/0/default.jpg',
  '2048,0,758,1024/379,512/0/default.jpg',
  '2048,0,758,1984/190,496/0/default.jpg',
  '2048,1024,512,512/512,512/0/default.jpg',
  '2048,1024,758,960/379,480/0/default.jpg',
  '2048,1536,512,448/512,448/0/default.jpg',
  '2048,512,512,512/512,512/0/default.jpg',
  '2560,0,246,512/246,512/0/default.jpg',
  '2560,1024,246,512/246,512/0/default.jpg',
  '2560,1536,246,448/246,448/0/default.jpg',
  '2560,512,246,512/246,512/0/default.jpg',
  '512,0,512,512/512,512/0/default.jpg',
  '512,1024,512,512/512,512/0/default.jpg',
  '512,1536,512,448/512,448/0/default.jpg',
  '512,512,512,512/512,512/0/default.jpg',
  'full/351,248/0/default.jpg',
];

/** Builds a tile source the way OpenSeadragon does after fetching `url`. */
function tileSource(osd: any, info: object, url = ID + '/info.json'): any {
  const data = JSON.parse(JSON.stringify(info));
  const T = osd.IIIFTileSource;
  return new T(T.prototype.configure.call({}, data, url));
}

/** Every tile URL of every level, in a fixed order. */
function allTileUrls(src: any): string[] {
  const urls: string[] = [];
  for (let level = src.minLevel; level <= src.maxLevel; level++) {
    const n = src.getNumTiles(level);
    for (let x = 0; x < n.x; x++) {
      for (let y = 0; y < n.y; y++) {
        urls.push(`${level}/${x}/${y} ${src.getTileUrl(level, x, y)}`);
      }
    }
  }
  return urls;
}

describe('ImageApiCompat: OpenSeadragon Image API 3.0 shim', () => {
  it('is idempotent on the npm module that OpenSeadragonOverlay shims', () => {
    applyTileSourceShim(OpenSeadragon);
    const getTileUrl = (OpenSeadragon as any).IIIFTileSource.prototype.getTileUrl;
    applyTileSourceShim(OpenSeadragon);
    expect((OpenSeadragon as any).IIIFTileSource.prototype.getTileUrl).to.equal(getTileUrl);
    expect((OpenSeadragon as any).IIIFTileSource.prototype.__imageApi3Shim).to.equal(true);
  });

  Object.keys(BUILDS).forEach((version) => {
    describe(`on OpenSeadragon ${version}`, () => {
      let plain: any;
      let osd: any;
      before(() => {
        plain = loadOpenSeadragon(BUILDS[version]);
        osd = loadOpenSeadragon(BUILDS[version]);
        applyTileSourceShim(osd);
      });

      it('loads the expected build, and the plain copy cannot open a 3.0 service', () => {
        expect(osd.version.versionStr).to.equal(version);
        expect(plain.IIIFTileSource.prototype.__imageApi3Shim).to.equal(undefined);
        expect(() => tileSource(plain, { '@context': V3, id: ID, protocol: PROTOCOL, width: 10, height: 10 })).to.throw(
          'IIIF required parameters not provided'
        );
      });

      Object.keys(LEGACY).forEach((name) => {
        it(`leaves every tile URL of "${name}" byte-identical`, () => {
          const before = allTileUrls(tileSource(plain, LEGACY[name]));
          const after = allTileUrls(tileSource(osd, LEGACY[name]));
          expect(before.length).to.be.greaterThan(0);
          expect(after).to.deep.equal(before);
        });
      });

      it('keeps the 2.x `w,` form', () => {
        const src = tileSource(osd, LEGACY['2.x level2, square tiles']);
        expect(src.getTileUrl(0, 0, 0)).to.equal(`${ID}/full/153,/0/default.jpg`);
        expect(src.getTileUrl(1, 0, 0)).to.equal(`${ID}/0,0,4096,4096/256,/0/default.jpg`);
        expect(src.getTileUrl(5, 19, 25)).to.equal(`${ID}/4864,6400,8,96/8,/0/default.jpg`);
        const pyramid = tileSource(osd, LEGACY['2.x level0 sizes pyramid']);
        expect(pyramid.emulateLegacyImagePyramid).to.equal(true);
        expect(pyramid.getTileUrl(0, 0, 0)).to.equal(`${ID}/full/152,/0/default.jpg`);
      });

      it('opens a 3.0 service that has `id` and no `@id`, with `w,h` tile sizes', () => {
        const src = tileSource(osd, {
          '@context': V3,
          id: ID,
          type: 'ImageService3',
          protocol: PROTOCOL,
          profile: 'level2',
          width: 4872,
          height: 6496,
          sizes,
          tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4, 8, 16, 32] }],
        });
        expect(src['@id']).to.equal(ID);
        expect(src.getTileUrl(0, 0, 0)).to.equal(`${ID}/full/153,203/0/default.jpg`);
        expect(src.getTileUrl(1, 0, 0)).to.equal(`${ID}/0,0,4096,4096/256,256/0/default.jpg`);
        expect(src.getTileUrl(5, 19, 25)).to.equal(`${ID}/4864,6400,8,96/8,96/0/default.jpg`);
        expect(allTileUrls(src).every((u) => /\/(\d+,\d+|max)\/0\/default\.jpg$/.test(u))).to.equal(true);
      });

      it('never asks a 3.0 service for a size larger than the region (3.0 needs `^` for that)', () => {
        const shapes = [
          { width: 4872, height: 6496, tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4, 8, 16, 32] }] },
          { width: 6492, height: 1284, tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4, 8, 16, 32] }] },
          { width: 2806, height: 1984, tiles: [{ width: 512, scaleFactors: [1, 2, 4, 8] }] },
          { width: 3001, height: 2999, tiles: [{ width: 1024, scaleFactors: [1, 2, 4] }] },
          { width: 180, height: 120, tiles: [{ width: 256, scaleFactors: [1, 2, 4] }] },
        ];
        const upscaled: string[] = [];
        shapes.forEach((shape) => {
          const src = tileSource(osd, {
            '@context': V3,
            id: ID,
            type: 'ImageService3',
            protocol: PROTOCOL,
            profile: 'level2',
            ...shape,
          });
          allTileUrls(src).forEach((u) => {
            const [region, size] = u
              .split(' ')[1]
              .slice(ID.length + 1)
              .split('/');
            if (size === 'max') {
              return;
            }
            const [rw, rh] = region === 'full' ? [shape.width, shape.height] : region.split(',').slice(2).map(Number);
            const [sw, sh] = size.split(',').map(Number);
            if (sw > rw || sh > rh) {
              upscaled.push(`${shape.width}x${shape.height} ${u}`);
            }
          });
        });
        expect(upscaled).to.deep.equal([]);
      });

      it('accepts a 3.0 `@context` array', () => {
        const src = tileSource(osd, {
          '@context': ['http://example.org/extension/context.json', V3],
          id: ID,
          type: 'ImageService3',
          protocol: PROTOCOL,
          profile: 'level2',
          width: 4872,
          height: 6496,
          tiles: [{ width: 256, scaleFactors: [1, 2, 4, 8, 16, 32] }],
        });
        expect(src.getTileUrl(1, 0, 0)).to.equal(`${ID}/0,0,4096,4096/256,256/0/default.jpg`);
      });

      it('recognises a 3.0 service by `type` alone', () => {
        const src = tileSource(osd, {
          '@context': 'http://example.org/extension/context.json',
          id: ID,
          type: 'ImageService3',
          protocol: PROTOCOL,
          profile: 'level1',
          width: 1000,
          height: 800,
          tiles: [{ width: 512, scaleFactors: [1, 2] }],
        });
        expect(src.getTileUrl(1, 1, 1)).to.equal(`${ID}/512,512,488,288/488,288/0/default.jpg`);
      });

      it('asks for `max` when a 3.0 image fits one tile at full size', () => {
        const src = tileSource(osd, {
          '@context': V3,
          id: ID,
          type: 'ImageService3',
          protocol: PROTOCOL,
          profile: 'level2',
          width: 180,
          height: 120,
          tiles: [{ width: 256, scaleFactors: [1, 2, 4] }],
        });
        expect(src.getTileUrl(src.maxLevel, 0, 0)).to.equal(`${ID}/full/max/0/default.jpg`);
      });

      it('falls back to the sizes pyramid for a 3.0 level0 service without tiles', () => {
        const src = tileSource(osd, {
          '@context': V3,
          id: ID,
          type: 'ImageService3',
          protocol: PROTOCOL,
          profile: 'level0',
          width: 4872,
          height: 6496,
          sizes,
        });
        expect(src.emulateLegacyImagePyramid).to.equal(true);
        expect(src.getTileUrl(0, 0, 0)).to.equal(`${ID}/full/152,203/0/default.jpg`);
        expect(src.getTileUrl(1, 0, 0)).to.equal(`${ID}/full/609,812/0/default.jpg`);
      });

      it('tiles a 3.0 level0 service that declares sizeByWh', () => {
        const src = tileSource(osd, {
          '@context': V3,
          id: ID,
          type: 'ImageService3',
          protocol: PROTOCOL,
          profile: 'level0',
          extraFeatures: ['sizeByWh'],
          width: 4872,
          height: 6496,
          sizes,
        });
        expect(src.emulateLegacyImagePyramid).to.not.equal(true);
        expect(src.getTileUrl(0, 0, 0)).to.equal(`${ID}/full/10,13/0/default.jpg`);
      });

      it('asks a static 3.0 level0 pyramid (vips --layout iiif3) only for files it wrote', () => {
        // runtime-data/assets/km-annotorious/iiif3-static/book3: its info.json and its 33 tiles
        const src = tileSource(osd, {
          '@context': V3,
          id: ID,
          type: 'ImageService3',
          profile: 'level0',
          protocol: PROTOCOL,
          tiles: [{ scaleFactors: [1, 2, 4, 8], width: 512 }],
          width: 2806,
          height: 1984,
        });
        const urls = allTileUrls(src).map((u) => u.split(' ')[1].slice(ID.length + 1));
        expect(urls.filter((u) => STATIC_PYRAMID.indexOf(u) === -1)).to.deep.equal([]);
        // 2.3.1 computes maxLevel as floor(sqrt(8)) = 2, so it never asks for the 1/8 level
        expect(urls.length).to.equal(version === '2.3.1' ? 32 : 33);
      });

      describe('requested service id', () => {
        const LORIS = 'https://www.e-codices.unifr.ch/loris/bbb/bbb-Mss-hh-I0003/bbb-Mss-hh-I0003_767.jp2';
        const LORIS_ENCODED = 'https://www.e-codices.unifr.ch/loris/bbb%2Fbbb-Mss-hh-I0003%2Fbbb-Mss-hh-I0003_767.jp2';
        const loris = { ...LEGACY['2.x Loris (1024 tiles, full size listed)'], '@id': LORIS_ENCODED };

        it('tiles under the requested id when `@id` differs only by percent-encoding', () => {
          const src = tileSource(osd, loris, LORIS + '/info.json');
          expect(src['@id']).to.equal(LORIS);
          expect(src.getTileUrl(src.maxLevel, 0, 0)).to.equal(`${LORIS}/0,0,1024,1024/1024,/0/default.jpg`);
          // the same tiles as the plain build, under the other spelling of the id
          const before = allTileUrls(tileSource(plain, loris, LORIS + '/info.json'));
          const after = allTileUrls(src);
          expect(after).to.deep.equal(before.map((u) => u.replace(LORIS_ENCODED, LORIS)));
        });

        it('does the same for a 3.0 `id`', () => {
          const src = tileSource(
            osd,
            {
              '@context': V3,
              id: LORIS_ENCODED,
              type: 'ImageService3',
              protocol: PROTOCOL,
              profile: 'level2',
              width: 4872,
              height: 6496,
              tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4, 8, 16, 32] }],
            },
            LORIS + '/info.json'
          );
          expect(src.getTileUrl(1, 0, 0)).to.equal(`${LORIS}/0,0,4096,4096/256,256/0/default.jpg`);
        });

        it('keeps `@id` when it names another host or path', () => {
          const other = 'https://collections.royalarmouries.org/iiif/3/aetopia/73/472/DI_2013_0869.ptif';
          const stored = 'https://collections.armouries.net/iiif/3/aetopia/73/472/DI_2013_0869.ptif';
          expect(
            tileSource(osd, { ...LEGACY['2.x level2, square tiles'], '@id': other }, stored + '/info.json')['@id']
          ).to.equal(other);
          expect(tileSource(osd, loris, LORIS.replace('_767', '_768') + '/info.json')['@id']).to.equal(LORIS_ENCODED);
        });

        it('keeps `@id` when OpenSeadragon was handed an info.json object, or the id is malformed', () => {
          const T = osd.IIIFTileSource;
          const fromObject = new T(T.prototype.configure.call({}, JSON.parse(JSON.stringify(loris))));
          expect(fromObject['@id']).to.equal(LORIS_ENCODED);
          const malformed = { ...loris, '@id': LORIS + '%E0%A4%A' };
          expect(tileSource(osd, malformed, LORIS + '/info.json')['@id']).to.equal(LORIS + '%E0%A4%A');
        });
      });
    });
  });
});
