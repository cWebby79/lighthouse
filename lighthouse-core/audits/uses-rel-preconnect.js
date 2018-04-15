/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

'use strict';

const Audit = require('./audit');
const Util = require('../report/v2/renderer/util');
const UnusedBytes = require('./byte-efficiency/byte-efficiency-audit');
const URL = require('../lib/url-shim');
// Preconnect establishes a "clean" socket. Chrome's socket manager will keep an unused socket
// around for 10s. Meaning, the time delta between processing preconnect a request should be <10s,
// otherwise it's wasted. We add a 5s margin so we are sure to capture all key requests.
// @see https://github.com/GoogleChrome/lighthouse/issues/3106#issuecomment-333653747
const PRECONNECT_SOCKET_MAX_IDLE = 15;

class UsesRelPreconnectAudit extends Audit {
  /**
   * @return {!AuditMeta}
   */
  static get meta() {
    return {
      name: 'uses-rel-preconnect',
      description: 'Avoid multiple, costly round trips to any origin',
      informative: true,
      helpText:
        'Consider adding preconnect or dns-prefetch resource hints to establish early ' +
        `connections to important third-party origins. [Learn more](https://developers.google.com/web/fundamentals/performance/resource-prioritization#preconnect).`,
      requiredArtifacts: ['devtoolsLogs'],
      scoreDisplayMode: Audit.SCORING_MODES.NUMERIC,
    };
  }

  /**
   * Check if record has valid timing
   * @param {!WebInspector.NetworkRequest} record
   * @return {!boolean}
   */
  static hasValidTiming(record) {
    return record.timing && record.timing.connectEnd > 0 && record.timing.connectStart > 0;
  }

  /**
   * Check is the connection is already open
   * @param {!WebInspector.NetworkRequest} record
   * @return {!boolean}
   */
  static hasAlreadyConnectedToOrigin(record) {
    return (
      record.timing.dnsEnd - record.timing.dnsStart === 0 &&
      record.timing.connectEnd - record.timing.connectStart === 0
    );
  }

  /**
   * Check is the connection has started before the socket idle time
   * @param {!WebInspector.NetworkRequest} record
   * @param {!WebInspector.NetworkRequest} mainResource
   * @return {!boolean}
   */
  static socketStartTimeIsBelowThreshold(record, mainResource) {
    return Math.max(0, record._startTime - mainResource._endTime) < PRECONNECT_SOCKET_MAX_IDLE;
  }

  /**
   * @param {!Artifacts} artifacts
   * @return {!AuditResult}
   */
  static async audit(artifacts) {
    const devtoolsLogs = artifacts.devtoolsLogs[UsesRelPreconnectAudit.DEFAULT_PASS];
    let maxWasted = 0;

    const [networkRecords, mainResource] = await Promise.all([
      artifacts.requestNetworkRecords(devtoolsLogs),
      artifacts.requestMainResource(devtoolsLogs),
    ]);

    const origins = networkRecords
      .filter(record => {
        return (
          // filter out all resources where timing info was invalid
          UsesRelPreconnectAudit.hasValidTiming(record) &&
          // filter out all resources that are loaded by the document
          record.initiatorRequest() !== mainResource &&
          // filter out all resources that have the same origin
          mainResource.parsedURL.securityOrigin() !== record.parsedURL.securityOrigin() &&
          // filter out urls that do not have an origin (data, ...)
          !!record.parsedURL.securityOrigin() &&
          // filter out all resources where origins are already resolved
          !UsesRelPreconnectAudit.hasAlreadyConnectedToOrigin(record) &&
          // make sure the requests are below the PRECONNECT_SOCKET_MAX_IDLE (15s) mark
          UsesRelPreconnectAudit.socketStartTimeIsBelowThreshold(record, mainResource)
        );
      })
      .map(record => record.parsedURL.securityOrigin());

    const preconnectOrigins = new Set(origins);
    let results = [];
    preconnectOrigins.forEach(origin => {
      const records = networkRecords.filter(record => record.parsedURL.securityOrigin() === origin);

      // Sometimes requests are done simultaneous and the connection has not been made
      // chrome will try to connect for each network record, we get the first record
      let firstRecordOfOrigin;
      records.forEach(record => {
        if (!firstRecordOfOrigin || record._startTime < firstRecordOfOrigin._startTime) {
          firstRecordOfOrigin = record;
        }
      });

      const connectionTime =
        firstRecordOfOrigin.timing.connectEnd - firstRecordOfOrigin.timing.dnsStart;
      const timeBetweenMainResourceAndDnsStart =
        firstRecordOfOrigin._startTime * 1000 -
        mainResource._endTime * 1000 +
        firstRecordOfOrigin.timing.dnsStart;
      const wastedMs = Math.min(connectionTime, timeBetweenMainResourceAndDnsStart);
      maxWasted = Math.max(wastedMs, maxWasted);
      results.push({
        url: new URL(firstRecordOfOrigin.url).origin,
        type: 'ms',
        wastedMs,
      });
    });

    results = results
      .sort((a, b) => b.wastedMs - a.wastedMs);

    const headings = [
      {key: 'url', itemType: 'url', text: 'Origin'},
      {key: 'wastedMs', itemType: 'ms', text: 'Potential Savings'},
    ];
    const summary = {wastedMs: maxWasted};
    const details = Audit.makeTableDetails(headings, results, summary);

    return {
      score: UnusedBytes.scoreForWastedMs(maxWasted),
      rawValue: maxWasted,
      displayValue: Util.formatMilliseconds(maxWasted),
      extendedInfo: {
        value: results,
      },
      details,
    };
  }
}

module.exports = UsesRelPreconnectAudit;
