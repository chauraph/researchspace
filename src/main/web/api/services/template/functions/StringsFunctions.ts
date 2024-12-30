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

export const StringsFunctions = {
  split: function(text: string, separator?: string) {
    if (typeof text !== 'string') {
      return [];
    }
    if (typeof separator !== 'string') {
      separator = ' ';
    }
    return text.split(separator);
  },
  includes: function (string: string, substring: string) {
    if (!string || !substring) {
      throw new Error('string or substring may simply not be defined');
    } else if (typeof string !== 'string' || typeof substring !== 'string') {
      throw new Error('includes needs a string to search');
    } else if (string.includes(substring)) {
      return true;
    } else {
      return false;
    }
  },
  /**
   * improvement: implement regex replace for higher reusability
   **/
  removeEscapeBackslashes(str: string) {
    return String(str).replace(/\\/g, '');
  },
  removeDoubleQuotes(str: string) {
    return String(str).replace(/(['"])/g, '');
  },
  findDoubleQuoteGroup(str: string, pos: number) {
    if (typeof str !== 'string') {
      throw new Error('findDoubleQuoteGroup needs a string to find');
    } 
    if (str.match(/"([^"]*)"/g))
      return str.match(/"([^"]*)"/g)[pos];
    else
      return null;
  },
  sanitizeJsonLikeString(str: string) {
    // Check if the first character is '[' or '{'
    if (str[0] === '[' || str[0] === '{') {
      str = str.slice(1);  // Remove the first character
    }
  
    // Check if the last character is ']' or '}'
    if (str[str.length - 1] === ']' || str[str.length - 1] === '}') {
      str = str.slice(0, -1);  // Remove the last character
    }
  
    return str;
  }  
};
