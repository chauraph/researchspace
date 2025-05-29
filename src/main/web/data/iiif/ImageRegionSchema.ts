/**
 * ResearchSpace
 * Copyright (C) 2022-2024, © Kartography Community Interest Company
 * Copyright (C) 2015-2020, © Trustees of the British Museum
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

import { vocabularies } from 'platform/api/rdf';
import { rso } from '../vocabularies';
import { getRegisteredPrefixes } from 'platform/api/services/namespace';

import * as Forms from 'platform/components/forms';

// original RS SubjectTemplate definition
// export const SubjectTemplate = `${rso.ImageRegion.value}/{{UUID}}`;

let resolvedSubjectTemplate: string | null = null;
let namespaceError: Error | null = null;

const namespacePromise = getRegisteredPrefixes().toPromise().then(prefixes => {
  const defaultNamespace = prefixes.Default || prefixes[''];
  if (!defaultNamespace) {
    throw new Error('No Default namespace found in configuration. Check your namespaces.prop file.');
  }
  resolvedSubjectTemplate = `${defaultNamespace}ImageRegion/{{UUID}}`;
  return resolvedSubjectTemplate;
}).catch(error => {
  namespaceError = error;
  console.error('CRITICAL: Failed to resolve namespace:', error);
  throw error;
});

export const getSubjectTemplate = async (): Promise<string> => {
  if (namespaceError) {
    throw new Error(`Namespace resolution failed: ${namespaceError.message}`);
  }
  
  if (!resolvedSubjectTemplate) {
    try {
      await namespacePromise;
      if (!resolvedSubjectTemplate) {
        throw new Error('SubjectTemplate not resolved after namespace loading completed');
      }
      return resolvedSubjectTemplate;
    } catch (error) {
      throw new Error(`Failed to resolve SubjectTemplate: ${error.message}`);
    }
  }
  
  return resolvedSubjectTemplate;
};

export const ImageRegionType = Forms.normalizeFieldDefinition({
  id: 'type',
  xsdDatatype: vocabularies.xsd._string,
  insertPattern: `INSERT { $subject a $value } WHERE {}`,
  selectPattern: `SELECT ?value WHERE { $subject a ?value }`,
});

export const ImageRegionLabel = Forms.normalizeFieldDefinition({
  id: 'label',
  xsdDatatype: vocabularies.xsd._string,
  insertPattern: `INSERT {
    $subject <http://www.cidoc-crm.org/cidoc-crm/P190_has_symbolic_content> $value .
  } WHERE {}`,
  selectPattern: `SELECT ?value WHERE {
    $subject <http://www.cidoc-crm.org/cidoc-crm/P190_has_symbolic_content> ?value .
  }`,
});

export const ImageRegionBoundingBox = Forms.normalizeFieldDefinition({
  id: 'boundingBox',
  xsdDatatype: vocabularies.xsd._string,
  insertPattern: `INSERT {
    $subject <http://www.researchspace.org/ontology/boundingBox> $value .
  } WHERE {}`,
  selectPattern: `SELECT ?value WHERE {
    $subject <http://www.researchspace.org/ontology/boundingBox> ?value .
  }`,
});

export const ImageRegionValue = Forms.normalizeFieldDefinition({
  id: 'value',
  xsdDatatype: vocabularies.xsd._string,
  insertPattern: `INSERT {
    $subject <http://www.w3.org/1999/02/22-rdf-syntax-ns#value> $value .
  } WHERE {}`,
  selectPattern: `SELECT ?value WHERE {
    $subject <http://www.w3.org/1999/02/22-rdf-syntax-ns#value> ?value .
  }`,
});

export const ImageRegionViewport = Forms.normalizeFieldDefinition({
  id: 'viewport',
  xsdDatatype: vocabularies.xsd._string,
  insertPattern: `INSERT {
    $subject <http://www.researchspace.org/ontology/viewport> $value .
  } WHERE {}`,
  selectPattern: `SELECT ?value WHERE {
    $subject <http://www.researchspace.org/ontology/viewport> ?value.
  }`,
});

export const ImageRegionIsPrimaryAreaOf = Forms.normalizeFieldDefinition({
  id: 'isPrimaryAreaOf',
  xsdDatatype: vocabularies.xsd.anyURI,
  insertPattern: `INSERT {
    $subject <http://www.ics.forth.gr/isl/CRMdig/L49_is_primary_area_of> $value .
  } WHERE {}`,
  selectPattern: `SELECT ?value WHERE {
    $subject <http://www.ics.forth.gr/isl/CRMdig/L49_is_primary_area_of> ?value .
  }`,
});

export const ImageRegionFields: ReadonlyArray<Forms.FieldDefinition> = [
  ImageRegionType,
  ImageRegionLabel,
  ImageRegionBoundingBox,
  ImageRegionValue,
  ImageRegionViewport,
  ImageRegionIsPrimaryAreaOf,
];
