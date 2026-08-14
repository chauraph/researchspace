# IIIF manifest fixtures

Fixtures for `IIIFManifestNormalizerTest`. Each one pins a shape that broke, or nearly broke, the
JSONPath extraction that `IIIFManifestNormalizer` replaced. Nothing here is a sample of real data
kept for its own sake: the institutional manifests are **trimmed to the two canvases that carry the
trap**, which is why the whole directory is under 150 KB.

Retrieved **2026-08-14**. Re-fetch with the URL in the table if a fixture ever needs refreshing, then
trim it again — do not commit a full institutional manifest.

| File | Source | Verbatim? | Pins |
|---|---|---|---|
| `v1_synthetic_spec10.json` | Presentation API 1.0 specification, section 5.4 example (via web.archive.org) | authored from the spec | the `shared-canvas` context, `sequences[].canvases[].images[]`, an Image API 1.1 service |
| `v1_variant_imageservice2.json` | derived from the above | authored | a v1 manifest whose service is a modern Image API 2 one |
| `v1_live_imageservice1.json` | derived from the above | authored | the same, pointed at IIIF's live 1.1 reference service |
| `v2_fixture1.json` | `https://iiif.io/api/presentation/2.1/example/fixtures/1/manifest.json` | verbatim | a canvas with **no** image service |
| `v2_bodleian.json` | `https://iiif.bodleian.ox.ac.uk/iiif/manifest/e32a277e-91e2-4a6d-8ba6-cc4bad230410.json` | trimmed to 2 canvases | Presentation 2 with `ImageService2`; the manifest claims level1 while info.json says level2 |
| `v2_wellcome.json` | `https://iiif.wellcomecollection.org/presentation/v2/b18035723` | trimmed to 2 canvases | Presentation 2 with `ImageService2` |
| `v2_variant_choice.json` | derived from `v2_bodleian` | authored | an `oa:Choice` body: the default alternative must win |
| `v2_variant_imageservice1.json` | derived from `v2_bodleian` | authored | Image API **1.1** service inside a v2 manifest |
| `v2_variant_imageservice3.json` | derived from `v2_bodleian` | authored | Image API **3** service inside a v2 manifest (`id`, not `@id`) |
| `v2_variant_no_motivation.json` | derived from `v2_bodleian` | authored | an image annotation with no `motivation`, which is still painting |
| `v2_variant_profile_array.json` | derived from `v2_bodleian` | authored | `profile` as an array with a nested object |
| `v2_variant_service_array.json` | derived from `v2_bodleian` | authored | `service` as an array rather than an object |
| `v3_cookbook_0001_extimage.json` | IIIF cookbook recipe 0001 | verbatim | a painted image with no service at all |
| `v3_cookbook_0002_audio.json` | IIIF cookbook recipe 0002 | verbatim | a non-image canvas |
| `v3_cookbook_0005_imageservice.json` | IIIF cookbook recipe 0005 | verbatim | the plain `ImageService3` case |
| `v3_cookbook_0009_book.json` | IIIF cookbook recipe 0009 | verbatim | several canvases, one service each |
| `v3_cookbook_0024_ranges.json` | IIIF cookbook recipe 0024 | verbatim | **six canvases repeated in `structures`**: the duplicate-row trap |
| `v3_cookbook_0033_choice.json` | IIIF cookbook recipe 0033 | verbatim | a Presentation 3 `Choice` body |
| `v3_cookbook_0064_video.json` | IIIF cookbook recipe 0003 | verbatim | a video canvas |
| `v3_wellcome.json` | `https://iiif.wellcomecollection.org/presentation/b18035723` | trimmed to 2 canvases + 1 range | an **array `@context`**, an `ImageService2` inside v3, and a `structures` stub |
| `v3_variant_context_array.json` | derived from cookbook 0005 | authored | an array `@context` on an otherwise plain v3 manifest |
| `v3_variant_imageservice1.json` | derived from cookbook 0005 | authored | an Image API 1.1 service inside a v3 manifest |
| `v3_variant_imageservice2.json` | derived from cookbook 0005 | authored | an `ImageService2` inside a v3 manifest, in isolation |
| `v4_spec_usecase1.json` | Presentation API 4.0 draft, "Use Case 1: Artwork" | authored from the spec | the 4.0 context and `"motivation": ["painting"]` |
| `v4_variant_motivation_string.json` | derived from the above | authored | the same manifest with a string `motivation`, to isolate the cause |

The IIIF cookbook recipes are published CC0. The Wellcome and Bodleian manifests are metadata records
of those institutions, kept here only as trimmed test input.
