/**
 * ResearchSpace
 * Copyright (C) 2022-2024, © Kartography Community Interest Company
 * Copyright (C) 2015-2020, © Trustees of the British Museum
 * Copyright (C) 2025, Tsz Kin Chau, eM+ / EPFL
 *
 * Modified in 2025 by Tsz Kin Chau.
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

export const ImageRegionAssignedBySegmentObservation = Forms.normalizeFieldDefinition({
  id: 'attributeBySegmentObservation',
  xsdDatatype: vocabularies.xsd.anyURI,
  insertPattern: `INSERT {
    $subject <http://www.cidoc-crm.org/cidoc-crm/P141i_was_assigned_by> ?assignment .
    ?assignment <http://www.cidoc-crm.org/cidoc-crm/P141_assigned> ?subject .
    ?subject crm:P2_has_type <http://www.researchspace.org/resource/vocab/image_annotation_type/observed_segment> .
    $value <http://www.cidoc-crm.org/cidoc-crm/P140i_was_attributed_by> ?assignment .
    ?assignment <http://www.cidoc-crm.org/cidoc-crm/P140_assigned_attribute_to> $value .
    ?assignment a <https://w3id.org/dsanno/ontology/core#DSA1_Scholarly_Assertion> .
    ?assignment a <http://www.cidoc-crm.org/cidoc-crm/E13_Attribute_Assignment> .
    ?assignment crm:P2_has_type <http://www.researchspace.org/resource/system/vocab/resource_type/segment_observation> .
    ?assignment crm:P177_assigned_property_of_type <http://www.cidoc-crm.org/cidoc-crm/P106_is_composed_of>.
    ?assignment crm:P1_is_identified_by ?appellation .

    ?appellation a crm:E41_Appellation .
    ?appellation crm:P2_has_type <http://www.researchspace.org/resource/system/vocab/resource_type/primary_appellation> . 
    ?appellation crm:P190_has_symbolic_content "segment observation"^^xsd:string .

    ?assignment crm:P129i_is_subject_of ?entity_form_record .
    ?entity_form_record crm:P129_is_about ?assignment .

    ?entity_form_record a crmdig:D1_Digital_Object .
    ?entity_form_record crm:P2_has_type <http://www.researchspace.org/resource/system/vocab/resource_type/entity_form_record> .
    <http://www.researchspace.org/resource/system/vocab/resource_type/entity_form_record> crm:P2i_is_type_of ?entity_form_record .

    ?entity_form_record crmdig:L11i_was_output_of ?entity_formRecord_creation .
    ?entity_formRecord_creation crmdig:L11_had_output ?entity_form_record .

    ?entity_formRecord_creation a crmdig:D7_Digital_Machine_Event .
    ?entity_formRecord_creation crm:P2_has_type <http://www.researchspace.org/resource/system/vocab/resource_type/entity_form_record_creation> .
    <http://www.researchspace.org/resource/system/vocab/resource_type/entity_form_record_creation> crm:P2i_is_type_of ?entity_formRecord_creation .

    ?entity_formRecord_creation crm:P4_has_time-span ?date .
    ?date a crm:E52_Time-Span . 
    ?date crm:P82_at_some_time_within ?currentTime .

    ?entity_formRecord_creation crm:P14_carried_out_by ?__useruri__ .
    ?__useruri__ crm:P14i_performed ?entity_formRecord_creation .

  } WHERE {
   BIND(IRI(CONCAT(STR($value), "/segment_observation/{{UUID}}")) AS ?assignment)
   BIND(IRI(CONCAT(STR(?assignment), "/primary_appellation")) AS ?appellation)
   BIND(IRI(CONCAT(STR(?assignment), "/entity_form_record")) AS ?entity_form_record)
   BIND(IRI(CONCAT(STR(?entity_form_record), "/entity_formRecord_creation")) AS ?entity_formRecord_creation)
   BIND(IRI(CONCAT(STR(?entity_formRecord_creation), "/at_some_time_within")) AS ?date)
   BIND(NOW() AS ?currentTime)
   }`,
  selectPattern: `SELECT ?value WHERE {
    $subject <http://www.cidoc-crm.org/cidoc-crm/P106i_forms_part_of> ?value .
    $value <http://www.cidoc-crm.org/cidoc-crm/P106_is_composed_of> $subject .
  }`,
});

export const ImageRegionFields: ReadonlyArray<Forms.FieldDefinition> = [
  ImageRegionType,
  ImageRegionLabel,
  ImageRegionBoundingBox,
  ImageRegionValue,
  ImageRegionViewport,
  ImageRegionIsPrimaryAreaOf,
  ImageRegionAssignedBySegmentObservation,
];
