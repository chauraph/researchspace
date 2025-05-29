/**
 * ResearchSpace
 * Copyright (C) 2020, © Trustees of the British Museum
 * Copyright (C) 2015-2019, metaphacts GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.

 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import { Rdf } from 'platform/api/rdf';
import { SparqlUtil } from 'platform/api/sparql';
import { SparqlClient } from 'platform/api/sparql';
import * as _ from 'lodash';
import * as SparqlJs from 'sparqljs';
import * as Kefir from 'kefir';

export const RdfFunctions = {
  isIri: function (value: Rdf.Node) {
    return value.isIri();
  },

  isBnode: function (value: Rdf.Node) {
    return value.isBnode();
  },

  isLiteral: function (value: Rdf.Node) {
    return value.isLiteral();
  },
  
/**
 * Executes a SPARQL query to get the RDF type(s) of a subject node and formats them as a string.
 * @param value - The subject node as an Rdf.Node
 * @returns A formatted string representation of the node types
 */
getNodeTypes: function (value: Rdf.Node): string {
  // If value is not provided or is not IRI or BNode, return empty string
  if (!value || (!value.isIri() && !value.isBnode())) {
    return '';
  }
  
  // Create a placeholder for the types that will be filled asynchronously
  const elementId = `node-types-${Math.random().toString(36).substring(2, 9)}`;
  
  // Start the async process to fetch types
  const query = `
    SELECT ?type ?auth_list_label ?crm_type_label
    WHERE {
      BIND(${value.toString()} AS ?node)
      ?node a ?type .
      OPTIONAL {
        ?node crm:P71i_is_listed_in ?auth_list .
        ?auth_list crm:P1_is_identified_by ?auth_list_appl .
        ?auth_list_appl crm:P2_has_type <http://www.researchspace.org/resource/system/vocab/resource_type/primary_appellation> .
        ?auth_list_appl crm:P190_has_symbolic_content ?auth_list_label.
    	  FILTER (lang(?auth_list_label) = "en" || lang(?auth_list_label) = "")
      }
       OPTIONAL {
        ?node crm:P2_has_type ?crm_type .
        ?crm_type skos:prefLabel ?crm_type_label .
	      ?crm_type crm:P71i_is_listed_in ?auth_list .
     	  FILTER (lang(?crm_type_label) = "en" || lang(?crm_type_label) = "")
      }
    }
  `;
  
  SparqlClient.select(query, { context: { repository: 'default' } })
    .map((res) => {
      // Process each binding to create the desired format
      return res.results.bindings.map(binding => {
        const typeIri = binding['type'] as Rdf.Iri;
        const authListLabel = binding['auth_list_label'] as Rdf.Literal;
        const crmTypeLabel = binding['crm_type_label'] as Rdf.Literal;
        
        // Format the type: either "type@additionaltype" or just "type"
        let typeStr = '';
        
        // Compact the main type if possible
        const typeCompacted = SparqlUtil.compactIriUsingPrefix(typeIri);
        typeStr = typeCompacted || typeIri.value;
        
        if (authListLabel) {
          typeStr += '→' + authListLabel.value;
        }

        if (crmTypeLabel) {
          typeStr += '→' + crmTypeLabel.value;
        }
        
        return typeStr;
      });
    })
    .onValue((typeFormats) => {
      // When we get the formatted types, find the element and update it
      const element = document.getElementById(elementId);
      if (element) {
        if (typeFormats && typeFormats.length > 0) {
          element.textContent = ` (${typeFormats.join(', ')})`;
        } else {
          element.textContent = '';
        }
      }
    });
  
  // Return HTML with a placeholder that will be updated when data arrives
  return `<span id="${elementId}"></span>`;
},

};