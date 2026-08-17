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

import * as React from 'react';
import * as Kefir from 'kefir';

import { Component } from 'platform/api/components';
import { Cancellation } from 'platform/api/async';
import { trigger, listen } from 'platform/api/events';
import { Rdf } from 'platform/api/rdf';
import { SparqlClient, SparqlUtil } from 'platform/api/sparql';
import { ErrorNotification } from 'platform/components/ui/notification';
import { Spinner } from 'platform/components/ui/spinner';

import {
  Capabilities,
  PreviewTile,
  SearchHit,
  SearchResponse,
  TileSearchClient,
  boundingBox,
  tileUrl,
} from './PyramidalTileSearchApi';
import {
  HitSelectedEvent,
  ResultsLoadedEvent,
  SearchEvent,
  SearchFailedEvent,
} from './PyramidalTileSearchEvents';

export type MarkerKind = 'line' | 'rect' | 'dot' | 'hairline-dot';
export type DiagnosticsMode = boolean | 'toggle';
export type QueryMode = 'text' | 'image';

export interface Props {
  /** Event addressing. */
  id: string;

  /**
   * Dereferenceable IIIF Image API base, for example
   * `https://example.org/iiif/panorama.tif`. Identical in every deployment, so this is the
   * portable identifier. Give this, `image-iri`, or both.
   */
  iiifService?: string;

  /**
   * The `rs:EX_Digital_Image` resource. Differs between deployments. It enables minting and
   * the viewer jump. Give this, `iiif-service`, or both.
   */
  imageIri?: string;

  /**
   * Which identifier wins when both are given and they disagree. Space separated, first wins.
   * Default `'iiif-service image-iri'`.
   */
  priorityId?: string;

  /** Proxy mount for the search service. Default `/proxy/tile-search`. */
  proxyPath?: string;

  /**
   * Restrict the query modes this page offers. The effective set is this list intersected
   * with what the deployment configures, so the prop can only restrict, never enable.
   */
  queryModes?: string;

  /** Named deduplication preset. An unknown name is reported as a configuration error. */
  dedupPreset?: string;

  /** Initial result count. Default 20. */
  defaultTopK?: number;

  /**
   * `'false'` hides retrieval internals and renders no control. `'true'` always shows them.
   * `'toggle'` renders a control in the results header and starts clean. Default `'false'`.
   *
   * The platform converts the attribute values `true` and `false` into booleans before the
   * component sees them, so this accepts a boolean or the literal string `'toggle'`.
   */
  showDiagnostics?: DiagnosticsMode;

  /** Locator marker scheme. Default `'hairline-dot'`. */
  locatorMarker?: MarkerKind;
}

interface State {
  capabilities?: Capabilities;
  /** Resolved from the props by the `image_service` field pattern. */
  resolvedService?: string;
  resolvedImageIri?: string;
  idWarning?: string;
  fatal?: string;

  mode: QueryMode;
  query: string;
  imageFile?: File;
  imagePreview?: string;

  backend?: string;
  levels: number[];
  tileSize?: number;
  topK: number;

  searching: boolean;
  response?: SearchResponse;
  error?: string;

  openTileId?: string;
  /** Overrides of the automatic merge pick, keyed by the representative tile id. */
  chosenCrop: { [representativeId: string]: PreviewTile };
  openMergeFor?: string;

  diagOn: boolean;
}

/**
 * The `image_service` field pattern from
 * `https://w3id.org/dsanno/platform/pattern/image/iiif_image/image_service`.
 *
 * The WHERE body is symmetric: bind `?image` to walk forwards, bind `?service` to walk
 * backwards. Only the projection changes, so a change to the pattern breaks both directions
 * visibly rather than leaving one silently stale.
 */
const ID_WHERE = `
    ?image crm:P129i_is_subject_of ?digitalObject .
    ?digitalObject a crmdig:D1_Digital_Object .
    ?digitalObject crm:P2_has_type <http://iiif.io/api/image> .
    ?digitalObject crm:P129i_is_subject_of ?service .
    ?service crm:P2_has_type <http://iiif.io/api/image#ImageService> .
`;

const ID_PREFIXES = `
  PREFIX crm: <http://www.cidoc-crm.org/cidoc-crm/>
  PREFIX crmdig: <http://www.ics.forth.gr/isl/CRMdig/>
`;

// A projected variable must stay a variable, so each direction projects only the unknown
// and binds the other. The WHERE body is the same text in both.
const SERVICE_TO_IMAGE = `${ID_PREFIXES} SELECT DISTINCT ?image WHERE {${ID_WHERE}}`;
const IMAGE_TO_SERVICE = `${ID_PREFIXES} SELECT DISTINCT ?service WHERE {${ID_WHERE}}`;

const DEFAULT_PROXY = '/proxy/tile-search';
const MAX_MERGE_MEMBERS = 8;

export class PyramidalTileSearch extends Component<Props, State> {
  static defaultProps: Partial<Props> = {
    proxyPath: DEFAULT_PROXY,
    priorityId: 'iiif-service image-iri',
    defaultTopK: 20,
    showDiagnostics: false,
    locatorMarker: 'hairline-dot',
  };

  private readonly cancellation = new Cancellation();
  private client: TileSearchClient;
  /** In flight search, aborted when a new one starts so results cannot arrive out of order. */
  private inflight?: AbortController;

  constructor(props: Props, context: any) {
    super(props, context);
    this.client = new TileSearchClient(props.proxyPath);
    this.state = {
      mode: 'text',
      query: '',
      levels: [],
      topK: Number(props.defaultTopK) || 20,
      searching: false,
      chosenCrop: {},
      diagOn: props.showDiagnostics === true,
    };
  }

  componentDidMount() {
    this.resolveIdentifiers();
    this.loadCapabilities();
    this.listenForSearch();
  }

  componentWillUnmount() {
    this.cancellation.cancelAll();
    if (this.inflight) {
      this.inflight.abort();
    }
  }

  // ---------------------------------------------------------------- identifiers

  private resolveIdentifiers() {
    const { iiifService, imageIri, priorityId } = this.props;
    if (!iiifService && !imageIri) {
      this.setState({
        fatal:
          'Set iiif-service, image-iri, or both. Without one of them the component cannot ' +
          'find the corpus.',
      });
      return;
    }

    const order = (priorityId || '').split(/\s+/).filter((s) => s.length > 0);
    const serviceFirst = order.indexOf('iiif-service') <= order.indexOf('image-iri');

    // Bind whichever identifier we were given. When both are given, bind the one that wins
    // so the other is verified against it rather than trusted.
    const authoritative = iiifService && (serviceFirst || !imageIri) ? 'service' : 'image';
    const query = SparqlUtil.parseQuery<any>(
      authoritative === 'service' ? SERVICE_TO_IMAGE : IMAGE_TO_SERVICE
    );
    const bindings =
      authoritative === 'service'
        ? { service: Rdf.iri(iiifService) }
        : { image: Rdf.iri(imageIri) };

    this.cancellation
      .map(SparqlClient.select(SparqlClient.setBindings(query, bindings as any)))
      .observe({
        value: ({ results }) => {
          const rows = results.bindings;
          const foundService =
            authoritative === 'image' && rows.length ? rows[0]['service'].value : undefined;
          const foundImage =
            authoritative === 'service' && rows.length ? rows[0]['image'].value : undefined;

          const resolvedService = authoritative === 'service' ? iiifService : foundService;
          const resolvedImageIri = authoritative === 'image' ? imageIri : foundImage;

          if (!resolvedService) {
            this.setState({
              fatal:
                `The image ${imageIri} has no IIIF image service in the store, so no tile ` +
                'URL can be built. Add one, or set iiif-service on the component.',
            });
            return;
          }

          let idWarning: string | undefined;
          if (iiifService && imageIri) {
            const other = authoritative === 'service' ? foundImage : foundService;
            const expected = authoritative === 'service' ? imageIri : iiifService;
            if (other && other !== expected) {
              idWarning =
                `iiif-service and image-iri disagree. The store links ${expected} to ` +
                `${other}. ${authoritative === 'service' ? 'iiif-service' : 'image-iri'} wins, ` +
                'as priority-id says.';
            }
          }
          if (!resolvedImageIri) {
            idWarning =
              'This IIIF service is not registered as an image in the store, so results are ' +
              'display only. Minting and the viewer jump are unavailable.';
          }
          if (rows.length > 1) {
            idWarning = 'More than one image claims this IIIF service. Minting is unavailable ' +
              'until that is corrected.';
          }

          this.setState({
            resolvedService,
            resolvedImageIri: rows.length > 1 ? undefined : resolvedImageIri,
            idWarning,
          });
        },
        error: (error) => this.setState({ fatal: `Identifier lookup failed. ${error}` }),
      });
  }

  // -------------------------------------------------------------- capabilities

  private loadCapabilities() {
    this.cancellation.map(Kefir.fromPromise(this.client.capabilities())).observe({
      value: (capabilities) => {
        const configured = capabilities.configured_query_type_backend_lists;
        const modes = this.effectiveModes(configured);
        const mode = modes.length ? modes[0] : 'text';
        this.setState({
          capabilities,
          mode,
          backend: capabilities.default_backend_for_query_type[mode],
          // Do not preselect a tile size. Sending one applies a metadata filter on every
          // search, which the index answers far more slowly than an unfiltered query.
        });
      },
      error: (error) =>
        this.setState({
          fatal:
            `The tile search service did not answer. ${error} ` +
            `Check config.proxy.tile-search.targetUri in proxy.prop.`,
        }),
    });
  }

  /** The prop can only restrict what the deployment configures. */
  private effectiveModes(configured: { text: string[]; image: string[] }): QueryMode[] {
    const available: QueryMode[] = [];
    if (configured.text && configured.text.length) {
      available.push('text');
    }
    if (configured.image && configured.image.length) {
      available.push('image');
    }
    const asked = (this.props.queryModes || '').split(/\s+/).filter((s) => s.length > 0);
    if (!asked.length) {
      return available;
    }
    return available.filter((m) => asked.indexOf(m) >= 0);
  }

  private listenForSearch() {
    this.cancellation
      .map(listen({ eventType: SearchEvent, target: this.props.id }))
      .observe({
        value: (event) => {
          this.setState(
            {
              mode: 'text',
              query: event.data.query,
              backend: event.data.backend || this.state.backend,
              topK: event.data.topK || this.state.topK,
            },
            // Abort and replace rather than guard: another component asking for a query has
            // moved the page on, so the answer still in flight is no longer the one wanted.
            () => this.startSearch()
          );
        },
      });
  }

  // ------------------------------------------------------------------- search

  /**
   * The user asking again. The service is CPU bound and admits one search at a time, so a
   * second click or Enter while one is running only buys a queue place and a 503; ignore it.
   */
  private runSearch = () => {
    if (this.state.searching) {
      return;
    }
    this.startSearch();
  };

  private startSearch = () => {
    const { mode, query, imageFile, backend, levels, tileSize, topK } = this.state;
    if (mode === 'text' && !query.trim()) {
      return;
    }
    if (mode === 'image' && !imageFile) {
      return;
    }

    // Encode time swings from under a second to several seconds depending on model warmth,
    // so successive searches really can resolve out of order. Abort the previous one.
    if (this.inflight) {
      this.inflight.abort();
    }
    this.inflight = new AbortController();
    const signal = this.inflight.signal;

    this.setState({ searching: true, error: undefined, openTileId: undefined, openMergeFor: undefined });

    // A metadata filter costs the index about a second, against ten milliseconds for an
    // unfiltered query, and it costs that whether or not it excludes anything. Selecting
    // every level is the same result set as selecting none, so send none.
    const allLevels = this.state.capabilities.corpus.pyramid_levels;
    const filtersEverything = levels.length === allLevels.length;
    const params = {
      topK,
      backend,
      pyramidLevels: filtersEverything ? [] : levels,
      tileSize,
      dedupPreset: this.props.dedupPreset,
    };
    const request =
      mode === 'text'
        ? this.client.searchByText(query, params, signal)
        : this.client.searchByImage(imageFile, params, signal);

    request.then(
      (response) => {
        if (signal.aborted) {
          return;
        }
        this.setState({ searching: false, response });
        trigger({
          eventType: ResultsLoadedEvent,
          source: this.props.id,
          data: {
            query: response.query || null,
            queryType: response.query_type,
            backend: response.backend,
            modelName: response.model_name || '',
            corpusFingerprint: response.corpus_fingerprint || '',
            hitCount: response.results.length,
          },
        });
      },
      (error) => {
        if (signal.aborted) {
          return;
        }
        const message = String(error && error.message ? error.message : error);
        this.setState({ searching: false, error: message });
        trigger({
          eventType: SearchFailedEvent,
          source: this.props.id,
          data: { query: mode === 'text' ? query : null, queryType: mode, error: message },
        });
      }
    );
  };

  // ------------------------------------------------------------------ helpers

  private diagnosticsVisible(): boolean {
    const mode = this.props.showDiagnostics;
    return mode === 'toggle' ? this.state.diagOn : mode === true;
  }

  /** The crop that will be minted: the reader's override when there is one. */
  private cropFor(hit: SearchHit): { region: SearchHit | PreviewTile; tileId: string } {
    const override = this.state.chosenCrop[hit.id];
    return override
      ? { region: { ...hit, global_x: override.gx, global_y: override.gy, global_w: override.gw, global_h: override.gh }, tileId: override.id }
      : { region: hit, tileId: hit.id };
  }

  private openHit = (hit: SearchHit) => {
    const next = this.state.openTileId === hit.id ? undefined : hit.id;
    this.setState({ openTileId: next, openMergeFor: undefined });
    if (!next) {
      return;
    }
    const { response, resolvedService, resolvedImageIri } = this.state;
    const crop = this.cropFor(hit);
    trigger({
      eventType: HitSelectedEvent,
      source: this.props.id,
      data: {
        iiifService: resolvedService,
        imageIri: resolvedImageIri,
        boundingBox: boundingBox(crop.region as any),
        tileId: crop.tileId,
        representativeTileId: hit.id,
        similarity: hit.similarity,
        pyramidLevel: hit.pyramid_level,
        backend: response.backend,
        modelName: response.model_name || '',
        corpusFingerprint: response.corpus_fingerprint || '',
      },
    });
  };

  // ------------------------------------------------------------------ render

  render() {
    const { fatal, capabilities, resolvedService } = this.state;
    if (fatal) {
      return <ErrorNotification errorMessage={fatal} />;
    }
    if (!capabilities || !resolvedService) {
      return <Spinner />;
    }
    return (
      <div className="pts">
        {this.renderToolbar()}
        {this.state.idWarning ? <div className="pts__warning">{this.state.idWarning}</div> : null}
        {this.renderResults()}
      </div>
    );
  }

  private renderToolbar() {
    const { capabilities, mode, backend, levels, tileSize, topK, query, searching } = this.state;
    const modes = this.effectiveModes(capabilities.configured_query_type_backend_lists);
    const backends = capabilities.configured_query_type_backend_lists[mode] || [];
    const warm = capabilities.query_type_backend_lists[mode] || [];

    return (
      <div className="pts__toolbar">
        <div className="pts__queryline">
          {mode === 'text' ? (
            <input
              className="pts__input"
              type="text"
              value={query}
              placeholder="Describe what to look for"
              aria-label="Search the tile index"
              onChange={(e) => this.setState({ query: e.currentTarget.value })}
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  this.runSearch();
                }
              }}
            />
          ) : (
            <input
              className="pts__input"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              aria-label="Image to search with"
              onChange={(e) => {
                const file = e.currentTarget.files && e.currentTarget.files[0];
                if (file) {
                  this.setState({ imageFile: file, imagePreview: URL.createObjectURL(file) });
                }
              }}
            />
          )}
          <button
            className="btn btn-action"
            type="button"
            disabled={searching}
            onClick={this.runSearch}
          >
            Search
          </button>
        </div>

        <div className="pts__ctrls">
          {modes.length > 1 ? (
            <div className="pts__field">
              <label>Query by</label>
              <div className="pts__seg" role="group" aria-label="Query mode">
                {modes.map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mode === m}
                    onClick={() =>
                      this.setState({
                        mode: m,
                        backend: capabilities.default_backend_for_query_type[m],
                        response: undefined,
                      })
                    }
                  >
                    {m === 'text' ? 'Text' : 'Image'}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {backends.length > 1 ? (
            <div className="pts__field">
              <label htmlFor={`${this.props.id}-backend`}>Backend</label>
              <select
                id={`${this.props.id}-backend`}
                className="pts__sel"
                value={backend || ''}
                onChange={(e) => this.setState({ backend: e.currentTarget.value })}
              >
                {backends.map((b) => (
                  <option key={b} value={b}>
                    {(capabilities.backends[b] && capabilities.backends[b].label) || b}
                    {warm.indexOf(b) < 0 ? ' (first query will be slow)' : ''}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="pts__field">
            <label>Pyramid levels</label>
            <div className="pts__chips">
              {capabilities.corpus.pyramid_levels.map((l) => (
                <button
                  key={l}
                  type="button"
                  className="pts__chip"
                  aria-pressed={levels.indexOf(l) >= 0}
                  onClick={() =>
                    this.setState({
                      levels:
                        levels.indexOf(l) >= 0 ? levels.filter((x) => x !== l) : levels.concat([l]),
                    })
                  }
                >
                  {l}
                </button>
              ))}
            </div>
          </div>

          {capabilities.corpus.tile_sizes.length > 1 ? (
            <div className="pts__field">
              <label htmlFor={`${this.props.id}-tilesize`}>Tile size</label>
              <select
                id={`${this.props.id}-tilesize`}
                className="pts__sel"
                value={tileSize || ''}
                onChange={(e) => this.setState({ tileSize: Number(e.currentTarget.value) })}
              >
                {capabilities.corpus.tile_sizes.map((t) => (
                  <option key={t} value={t}>{`${t} px`}</option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="pts__field">
            <label htmlFor={`${this.props.id}-topk`}>Results</label>
            <input
              id={`${this.props.id}-topk`}
              className="pts__sel pts__num"
              type="number"
              min={1}
              max={100}
              value={topK}
              onChange={(e) => this.setState({ topK: Number(e.currentTarget.value) })}
            />
          </div>
        </div>
      </div>
    );
  }

  private renderResults() {
    const { searching, error, response, capabilities } = this.state;
    if (searching) {
      return (
        <div className="pts__state">
          <p>
            Searching
            {this.diagnosticsVisible() && capabilities.corpus.total_tiles
              ? ` ${capabilities.corpus.total_tiles.toLocaleString()} tiles`
              : ''}
            …
          </p>
          <Spinner />
        </div>
      );
    }
    if (error) {
      return <ErrorNotification errorMessage={error} />;
    }
    if (!response) {
      return <div className="pts__state">
        <p>{this.state.mode === 'text' ? 'Enter a query and press Search.' : 'Choose an image and press Search.'}</p>
      </div>;
    }
    if (!response.results.length) {
      return <div className="pts__state"><p>No tiles matched.</p></div>;
    }

    const diag = this.diagnosticsVisible();
    return (
      <div className="pts__results">
        <div className="pts__panelhead">
          <h3>Results</h3>
          {response.filter_info ? <span className="pts__filter">{response.filter_info}</span> : null}
          {this.props.showDiagnostics === 'toggle' ? (
            <label className="pts__check">
              <input
                type="checkbox"
                checked={this.state.diagOn}
                onChange={(e) => this.setState({ diagOn: e.currentTarget.checked })}
              />
              Retrieval detail
            </label>
          ) : null}
          <span className="pts__count">{response.results.length}</span>
        </div>

        {diag ? this.renderPipeline(response) : null}
        {this.renderLocator(response)}

        <div className="pts__grid">{response.results.map((hit, i) => this.renderCard(hit, i, diag))}</div>
      </div>
    );
  }

  private renderPipeline(response: SearchResponse) {
    const pp = response.postprocess || {};
    return (
      <div className="pts__pipe">
        <span>
          Candidates <b>{pp.raw_candidates}</b>
        </span>
        <span className="pts__arrow">→</span>
        <span>
          After overlap merge <b>{pp.after_spatial_merge}</b>
        </span>
        <span className="pts__arrow">→</span>
        <span>
          Shown <b>{pp.returned_results}</b>
        </span>
        <span className="pts__div" />
        <span>
          Suppressed <b>{pp.spatial_suppressed_total}</b>
        </span>
        <span className="pts__div" />
        <span>
          Encode <b>{response.timings.encode_time.toFixed(2)}s</b> · search{' '}
          <b>{response.timings.search_time.toFixed(3)}s</b>
        </span>
        <span className="pts__div" />
        <span>
          Index <b>{(response.corpus_fingerprint || '').slice(0, 8)}</b>
        </span>
      </div>
    );
  }

  private renderLocator(response: SearchResponse) {
    const { resolvedService, capabilities } = this.state;
    const liftW = capabilities.corpus.lift_width || response.results[0].lift_width;
    const liftH = capabilities.corpus.lift_height || response.results[0].lift_height;
    if (!liftW || !liftH) {
      return null;
    }
    const kind = this.props.locatorMarker;
    const context = `${resolvedService.replace(/\/$/, '')}/full/1400,/0/default.jpg`;

    return (
      <div className="pts__locator">
        <div className="pts__lochead">
          <h4>Where these hits sit on the image</h4>
          <span>Hover a marker or a card to link the two</span>
        </div>
        <div className="pts__strip">
          <img src={context} alt="The whole image, for locating results" />
          {response.results.map((hit, i) => {
            const cx = (100 * (hit.global_x + hit.global_w / 2)) / liftW;
            const cy = (100 * (hit.global_y + hit.global_h / 2)) / liftH;
            const w = (100 * hit.global_w) / liftW;
            const h = (100 * hit.global_h) / liftH;
            const d = 4 + ((hit.pyramid_level || 3) - 3) * 1.8;
            return (
              <button
                key={hit.id}
                type="button"
                className={`pts__mark pts__mark--${kind}`}
                style={{ left: `${cx}%` }}
                aria-label={`Hit ${i + 1}`}
                onClick={() => this.openHit(hit)}
              >
                <span className="pts__markn">{i + 1}</span>
                {kind === 'rect' ? (
                  <span
                    className="pts__mrect"
                    style={{
                      left: '50%',
                      marginLeft: `${-w / 2}%`,
                      top: `${(100 * hit.global_y) / liftH}%`,
                      width: `${w}%`,
                      height: `${h}%`,
                    }}
                  />
                ) : null}
                {kind === 'dot' || kind === 'hairline-dot' ? (
                  <span
                    className="pts__mdot"
                    style={{ left: '50%', top: `${cy}%`, width: `${d}px`, height: `${d}px` }}
                  />
                ) : null}
                {kind === 'hairline-dot' ? <span className="pts__mfaint" style={{ left: '50%' }} /> : null}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  private renderCard(hit: SearchHit, index: number, diag: boolean) {
    const { resolvedService, resolvedImageIri, openTileId, chosenCrop } = this.state;
    const open = openTileId === hit.id;
    const crop = this.cropFor(hit);
    const override = chosenCrop[hit.id];
    const merged = hit.dedup && hit.dedup.merged;

    return (
      <article key={hit.id} className="pts__card" data-open={open}>
        <div className="pts__thumb">
          <img src={tileUrl(resolvedService, crop.region as any)} alt={`Result ${index + 1}`} />
          {diag && hit.pyramid_level !== undefined ? (
            <span className="pts__lvl">{`L${hit.pyramid_level}`}</span>
          ) : null}
        </div>
        <div className="pts__cap">
          <div className="pts__captype">
            <span>{`${(crop.region as any).global_w / 1000}k px wide`}</span>
            {diag ? <span className="pts__sim">{hit.similarity.toFixed(3)}</span> : null}
          </div>
          <button
            className="pts__caplabel"
            type="button"
            aria-expanded={open}
            onClick={() => this.openHit(hit)}
          >
            {diag ? hit.id : open ? 'Hide detail' : 'Open detail'}
          </button>
          <div className="pts__simbar">
            <span style={{ width: `${this.relativeWidth(hit)}%` }} />
          </div>
          {diag && merged ? (
            <button
              type="button"
              className="pts__pill"
              onClick={() =>
                this.setState({
                  openMergeFor: this.state.openMergeFor === hit.id ? undefined : hit.id,
                  openTileId: hit.id,
                })
              }
            >
              {`+${hit.dedup.suppressed_count} merged`}
            </button>
          ) : null}
          {override ? <span className="pts__override">{`Using level ${override.pyramid_level} crop`}</span> : null}
        </div>

        {open ? (
          <div className="pts__detail">
            <div className="pts__dl">
              <div>
                <span className="pts__k">Crop size</span>
                <span className="pts__v">{`${(crop.region as any).global_w.toLocaleString()} × ${(crop.region as any).global_h.toLocaleString()} px`}</span>
              </div>
              {diag ? (
                <div>
                  <span className="pts__k">Pyramid level</span>
                  <span className="pts__v">{hit.pyramid_level}</span>
                </div>
              ) : null}
              {diag && hit.row !== undefined ? (
                <div>
                  <span className="pts__k">Grid position</span>
                  <span className="pts__v">{`r${hit.row} c${hit.col}`}</span>
                </div>
              ) : null}
              {diag && hit.job_id !== undefined ? (
                <div>
                  <span className="pts__k">Extraction job</span>
                  <span className="pts__v">{hit.job_id}</span>
                </div>
              ) : null}
            </div>

            {diag ? (
              <div className="pts__bboxrow">
                <span className="pts__k">Region</span>
                <code className="pts__bbox">{boundingBox(crop.region as any)}</code>
              </div>
            ) : null}

            {this.state.openMergeFor === hit.id ? this.renderMergeInspector(hit) : null}

            <div className="pts__actions">
              {resolvedImageIri ? (
                <>
                  <button
                    className="btn btn-action"
                    type="button"
                    disabled
                    title={
                      'Not implemented yet. The selection is already published on ' +
                      'PyramidalTileSearch.HitSelected with the bounding box and the model ' +
                      'that produced it; a listener performs the write once the provenance ' +
                      'shape for a machine appraisal is agreed.'
                    }
                  >
                    Mint region
                  </button>
                  <span className="pts__hint">
                    Published on HitSelected as {boundingBox(crop.region as any)}
                  </span>
                </>
              ) : (
                <span className="pts__hint">
                  This IIIF service is not registered as an image in the store, so this hit is
                  display only.
                </span>
              )}
            </div>
          </div>
        ) : null}
      </article>
    );
  }

  /**
   * Text hits cluster near 0.18 and image hits near 0.80, so an absolute axis would be
   * useless for both. The bar spans the visible result set; the figure beside it stays
   * absolute.
   */
  private relativeWidth(hit: SearchHit): number {
    const sims = this.state.response.results.map((r) => r.similarity);
    const lo = Math.min(...sims);
    const hi = Math.max(...sims);
    return hi > lo ? 10 + (90 * (hit.similarity - lo)) / (hi - lo) : 100;
  }

  /**
   * Deduplication picks a representative to make the result set good. Minting wants the crop
   * that best bounds the subject. Those objectives differ, so the pruned candidates are worth
   * showing and overriding.
   *
   * Members can span a very wide size range, so every candidate is drawn at the same display
   * size and the real scale is carried by the figure and the bar instead.
   */
  private renderMergeInspector(hit: SearchHit) {
    const tiles = (hit.dedup.preview_tiles || []).slice().sort((a, b) => a.gw - b.gw);
    if (!tiles.length) {
      return null;
    }
    const shown = tiles.slice(0, MAX_MERGE_MEMBERS);
    const lo = Math.log2(tiles[0].gw);
    const hi = Math.log2(tiles[tiles.length - 1].gw);
    const { resolvedService } = this.state;

    return (
      <div className="pts__merge">
        <div className="pts__mergehead">
          {`Merge group — ${tiles.length} candidates, ${tiles.length - 1} pruned`}
          {tiles.length > shown.length ? (
            <span className="pts__hint">{` Showing ${shown.length} of ${tiles.length} by size.`}</span>
          ) : null}
        </div>
        <div className="pts__strip2">
          {shown.map((t) => {
            const f = hi > lo ? (Math.log2(t.gw) - lo) / (hi - lo) : 1;
            const chosen = this.state.chosenCrop[hit.id];
            const isChosen = chosen ? chosen.id === t.id : t.representative;
            return (
              <div key={t.id} className={`pts__mem${isChosen ? ' pts__mem--on' : ''}`}>
                <div className="pts__memimg">
                  <img src={tileUrl(resolvedService, { global_x: t.gx, global_y: t.gy, global_w: t.gw, global_h: t.gh }, 240)} alt={`Candidate at level ${t.pyramid_level}`} />
                  <span className="pts__lvl">{`L${t.pyramid_level}`}</span>
                  {t.representative ? <span className="pts__star">★ kept</span> : null}
                </div>
                <div className="pts__memmeta">
                  <span className="pts__mempx">{`${t.gw.toLocaleString()} px`}</span>
                  <span className="pts__memsim">{`sim ${t.similarity.toFixed(4)}`}</span>
                  <span className="pts__memscale">
                    <span style={{ width: `${10 + f * 90}%` }} />
                  </span>
                  <button
                    type="button"
                    className="btn pts__pick"
                    disabled={isChosen}
                    onClick={() =>
                      this.setState(
                        { chosenCrop: { ...this.state.chosenCrop, [hit.id]: t } },
                        () => this.republishSelection(hit)
                      )
                    }
                  >
                    {isChosen ? 'In use' : 'Use this'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <p className="pts__hint">
          Every candidate is shown at the same display size so its content stays readable. Real
          size is carried by the figure and the bar, never by how large the picture is.
        </p>
      </div>
    );
  }

  /** Re-publish the selection after the reader overrode the automatic crop. */
  private republishSelection(hit: SearchHit) {
    this.setState({ openTileId: undefined }, () => this.openHit(hit));
  }
}

export default PyramidalTileSearch;
