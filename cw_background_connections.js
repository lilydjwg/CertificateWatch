/*
 * Copyright 2019 PilzAdam
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

"use strict";
/* global CW */

/*
 * Background script that intercepts and checks all TLS connections.
 */

function isIgnoredDomain(host, ignoredDomains) {
	const hostParts = host.split(".");
	for (let filter of ignoredDomains) {
		filter = filter.trim();
		if (filter.length > 0) {
			const filterParts = filter.split(".");
			if (filterParts.length === hostParts.length) {
				let match = true;
				for (let i = 0; i < filterParts.length; i++) {
					if (filterParts[i] !== "*" && filterParts[i] !== hostParts[i]) {
						match = false;
						break;
					}
				}

				if (match) {
					CW.logDebug("Ignoring domain", host, "because it matches", filter);
					return true;
				}
			}
		}
	}

	return false;
}

function analyzeCert(host, securityInfo, result) {
	if (!securityInfo.certificates || securityInfo.certificates.length !== 1) {
		result.status = CW.CERT_ERROR;
		return;
	}

	const cert = CW.Certificate.fromBrowserCert(securityInfo.certificates[0]);
	const storedCert = CW.Certificate.fromStorage(host);

	if (!storedCert) {
		result.status = CW.CERT_TOFU;
		cert.store(host);

	} else {
		const changes = {};
		const checkedFields = CW.getSetting("checkedFields",
				["subject", "issuer", "validity", "subjectPublicKeyInfoDigest", "serialNumber", "fingerprint"]);
		let checkedFieldChanged = false;
		// fields are roughly sorted by importance
		for (const field of ["subject", "issuer", "validity", "subjectPublicKeyInfoDigest", "serialNumber", "fingerprint"]) {
			if (field === "validity") {
				// validity needs extra comparison logic
				if (cert.validity.start !== storedCert.validity.start ||
						cert.validity.end !== storedCert.validity.end) {
					changes.validity = {
						stored: {start: storedCert.validity.start, end: storedCert.validity.end},
						got: {start: cert.validity.start, end: cert.validity.end}
					};
					if (checkedFields.includes(field)) {
						checkedFieldChanged = true;
					}
				}
			} else {
				if (cert[field] !== storedCert[field]) {
					changes[field] = {
						stored: storedCert[field],
						got: cert[field]
					};
					if (checkedFields.includes(field)) {
						checkedFieldChanged = true;
					}
				}
			}
		}

		if (Object.keys(changes).length > 0) {
			if (checkedFieldChanged) {
				result.status = CW.CERT_CHANGED;
				result.changes = changes;
				result.stored = storedCert;
				result.got = cert;
				result.accepted = false;
			} else {
				// if no "important" field changed, just accept it
				result.status = CW.CERT_STORED;
				cert.store(host);
			}

		} else {
			result.status = CW.CERT_STORED;
			storedCert.seen();
			storedCert.store(host);
		}
	}
}

async function checkConnection(url, securityInfo, tabId) {
	if (CW.enabled === false || CW.storageInitialized === false) {
		return;
	}

	let host;
	try {
		const match = new RegExp("([a-z]+)://([^/:]+)").exec(url);
		//const baseUrl = match[0];
		host = match[2].replace(new RegExp("\\.$"), ""); // remove trailing .

		if (tabId === -1) {
			CW.logDebug("Request to", url, "not made in a tab");
			// TODO: what to do with requests not attached to tabs?
			return;
		}

		const certChecksSetting = CW.getSetting("certChecks");
		if (certChecksSetting === "domain") {
			const tab = await browser.tabs.get(tabId);
			const tabHost = new RegExp("://([^/]+)").exec(tab.url)[1]
					.replace(new RegExp("\\.$"), ""); // remove trailing .
			if (host !== tabHost) {
				CW.logDebug("Ignoring request to", host, "from tab with host", tabHost,
						"(setting is", certChecksSetting, ")");
				return;
			}
		}

		const ignoredDomains = CW.getSetting("ignoredDomains", []);
		if (isIgnoredDomain(host, ignoredDomains)) {
			return;
		}

		if (securityInfo.state === "secure" || securityInfo.state === "weak") {
			const result = new CW.CheckResult(host);
			await analyzeCert(host, securityInfo, result);

			CW.logDebug(host, result.status.text);

			const tab = CW.getTab(tabId);
			tab.addResult(result);
			CW.updateTabIcon(tabId);
		}
	} catch (e) {
		CW.logDebug("Error during connection checking", e);

		// add an internal error result
		const tab = CW.getTab(tabId);
		tab.addResult(new CW.CheckResult(host ? host : ""));
		CW.updateTabIcon(tabId);
	}
}

async function onHeadersReceived(details) {
	// only query securityInfo and then quickly return
	// checkConnection() is executed async
	// this makes blocking the request as short as possible
        if(details.fromCache) return;
	const securityInfo = await browser.webRequest.getSecurityInfo(details.requestId, {});
	checkConnection(details.url, securityInfo, details.tabId);
}

browser.webRequest.onHeadersReceived.addListener(
	onHeadersReceived,
	{urls: [
		"https://*/*",
		"wss://*/*"
	]},
	// we have to set the option "blocking" for browser.webRequest.getSecurityInfo
	["blocking"]
);

/*
 * create a listener that changes the "certChecks" setting if the "tabs"
 * optional permission is removed.
 * TODO: not yet implemented in firefox
 */
/*browser.permissions.onRemoved.addListener((removed) => {
	if (removed.permissions && removed.permissions.includes("tabs")) {
		if (CW.getSetting("certChecks") === "domain") {
			CW.logInfo("Optional \"tabs\" permission got removed; reverting to checking all domains");
			CW.setSetting("certChecks", "all");
		}
	}
});*/
