/*
 * ***** BEGIN LICENSE BLOCK *****
 *
 * RequestPolicy - A Firefox extension for control over cross-site requests.
 * Copyright (c) 2008 Justin Samuel
 * Copyright (c) 2014 Martin Kimmerle
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more
 * details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <http://www.gnu.org/licenses/>.
 *
 * ***** END LICENSE BLOCK *****
 */

import {createExtendedLogger} from "content/lib/logger";
import {DomainUtil} from "content/lib/utils/domains";
import {WindowUtils} from "content/lib/utils/windows";
import {HttpChannelWrapper} from "content/lib/http-channel-wrapper";

const logRequests = createExtendedLogger({
  enabledCondition: {type: "C", C: "LOG_REQUESTS"},
  level: "all",
  name: "Requests",
});

// =============================================================================
// constants
// =============================================================================

export const REQUEST_TYPE_NORMAL = 1;
export const REQUEST_TYPE_REDIRECT = 2;

const INTERNAL_SCHEMES = new Set([
  "resource",
  "about",
  "chrome",
  "moz-extension",
  "moz-icon",
  "moz-filedata",
]);

const WHITELISTED_DESTINATION_SCHEMES = new Set([
  "data",
  "blob",
  "wyciwyg",
  "javascript",
]);

const DEFAULT_ALLOWED_SCHEMES = new Set([
  "moz-extension",
]);

const DEFAULT_ALLOWED_DESTINATION_RESOURCE_URIS = new Set([
  // Viewing resources (text files, images, etc.) directly in a tab

  // images (png, jpg, etc.)
  "resource://gre/res/ImageDocument.css",
  "resource://gre/res/TopLevelImageDocument.css",
  // plain text
  "resource://gre-resources/plaintext.css",
  // videos
  "resource://gre/res/TopLevelVideoDocument.css",
]);

/* eslint-disable new-cap */
const profileUri = (function() {
  const fileHandler = Services.io.getProtocolHandler("file").
      QueryInterface(Ci.nsIFileProtocolHandler);
  const profileDir = Services.dirsvc.get("ProfD", Ci.nsIFile);
  return fileHandler.getURLSpecFromDir(profileDir);
})();
/* eslint-enable new-cap */

const WHITELISTED_DESTINATION_JAR_PATH_STARTS = [
  profileUri + "extensions/", // issue #860
];

// =============================================================================
// Request
// =============================================================================

export function Request(originURI, destURI, requestType) {
  // TODO: save a nsIURI objects here instead of strings
  this.originURI = originURI;
  this.destURI = destURI;
  this.requestType = requestType;

  // TODO: Merge "RequestResult" into this class.
  this.requestResult = undefined;
}

Object.defineProperty(RedirectRequest.prototype, "originUriObj", {
  get: function() {
    if (!this.originURI) return null;
    return Services.io.newURI(this.originURI, null, null);
  },
});

Object.defineProperty(Request.prototype, "destUriObj", {
  get: function() {
    return Services.io.newURI(this.destURI, null, null);
  },
});

Request.prototype.setOriginURI = function(originURI) {
  this.originURI = originURI;
};

Request.prototype.setDestURI = function(destURI) {
  this.destURI = destURI;
};

Request.prototype.detailsToString = function() {
  // Note: try not to cause side effects of toString() during load, so "<HTML
  // Element>" is hard-coded.
  return "destination: " + this.destURI + ", origin: " + this.originURI;
};

Request.prototype.isTopLevel = function() {
  return this.getContentPolicyType() === Ci.nsIContentPolicy.TYPE_DOCUMENT;
};

/**
  * Determines if a request is only related to internal resources.
  *
  * @return {Boolean} true if the request is only related to internal
  *         resources.
  */
Request.prototype.isInternal = function() {
  // TODO: investigate "moz-nullprincipal". The following comment has been
  //       created by @jsamuel in 2008, commit 46a04bb. More information about
  //       principals at https://developer.mozilla.org/en-US/docs/Mozilla/Gecko/Script_security
  //
  // Note: Don't OK the origin scheme "moz-nullprincipal" without further
  // understanding. It appears to be the source when the `js_1.html` test is
  // used. That is, javascript redirect to a "javascript:" url that creates the
  // entire page's content which includes a form that it submits. Maybe
  // "moz-nullprincipal" always shows up when using "document.location"?

  let origin = this.originUriObj;
  let dest = this.destUriObj;

  if (origin === undefined || origin === null) {
    logRequests.log("Allowing request without an origin.");
    return true;
  }

  if (origin.spec === "") {
    // The spec can be empty if odd things are going on, like the Refcontrol
    // extension causing back/forward button-initiated requests to have
    // aRequestOrigin be a virtually empty nsIURL object.
    logRequests.log("Allowing request with empty origin spec!");
    return true;
  }

  // Fully internal requests.
  if (INTERNAL_SCHEMES.has(dest.scheme) &&
      (
        INTERNAL_SCHEMES.has(origin.scheme) ||
        // e.g.
        // data:application/vnd.mozilla.xul+xml;charset=utf-8,<window/>
        // resource://b9db16a4-6edc-47ec-a1f4-b86292ed211d/data/mainPanel.html
        origin.spec.startsWith("data:application/vnd.mozilla.xul+xml")
      )) {
    logRequests.log("Allowing internal request.");
    return true;
  }

  if (WHITELISTED_DESTINATION_SCHEMES.has(dest.scheme)) {
    logRequests.log("Allowing request with a semi-internal destination.");
    return true;
  }

  let destHost = DomainUtil.getHostByUriObj(dest);

  // "global" dest are [some sort of interal requests]
  // "browser" dest are [???]
  if (destHost === "global" || destHost === "browser") {
    return true;
  }

  // See RP issue #788
  if (origin.scheme === "view-source" &&
      dest.spec === "resource://gre-resources/viewsource.css") {
    return true;
  }

  if (dest.scheme === "jar") {
    const {path} = dest;
    for (let pathStart of WHITELISTED_DESTINATION_JAR_PATH_STARTS) {
      if (path.startsWith(pathStart)) return true;
    }
  }

  // Empty iframes will have the "about:blank" URI. Sometimes websites
  // create an empty iframe and then manipulate it.
  // References:
  // - NoScript FAQ: https://noscript.net/faq#qa1_9
  // - RP issue #784
  if (dest.spec === "about:blank") {
    return true;
  }

  // see issue #180
  if (origin.scheme === "about" &&
      origin.spec.indexOf("about:neterror?") === 0) {
    return true;
  }

  return false;
};

Request.prototype.isAllowedByDefault = function() {
  if (
      this.aExtra &&
      this.aExtra instanceof Ci.nsISupportsString &&
      this.aExtra.data === "conPolCheckFromDocShell"
  ) return true;

  if (
      this.aRequestPrincipal &&
      Services.scriptSecurityManager.isSystemPrincipal(
          this.aRequestPrincipal)
  ) return true;

  let origin = this.originUriObj;
  let dest = this.destUriObj;

  if (
      origin && DEFAULT_ALLOWED_SCHEMES.has(origin.scheme) ||
      DEFAULT_ALLOWED_SCHEMES.has(dest.scheme)
  ) return true;

  if (dest.scheme === "chrome") {
    // Necessary for some Add-ons, e.g. "rikaichan" or "Grab and Drag"
    // References:
    // - RP issue #784
    if (dest.path.startsWith("/skin/")) return true;
    // See RP issue #797
    if (dest.spec === "chrome://pluginproblem/content/pluginProblem.xml") {
      return true;
    }
  }

  let destHost = DomainUtil.getHostByUriObj(dest);

  if (
      dest.scheme === "resource" && (
          destHost && destHost.startsWith("noscript_") || // RP issue #788
          DEFAULT_ALLOWED_DESTINATION_RESOURCE_URIS.has(dest.spec)
      )
  ) return true;

  return false;
};

// =============================================================================
// NormalRequest
// =============================================================================

export function NormalRequest(aContentType, aContentLocation, aRequestOrigin,
    aContext, aMimeTypeGuess, aExtra, aRequestPrincipal) {
  Request.call(this,
      // About originURI and destURI:
      // We don't need to worry about ACE formatted IDNs because it seems
      // that they'll automatically be converted to UTF8 format before we
      // even get here, as long as they're valid and Mozilla allows the TLD
      // to have UTF8 formatted IDNs.
      aRequestOrigin ? aRequestOrigin.specIgnoringRef : undefined, // originURI
      aContentLocation.specIgnoringRef, // destURI
      REQUEST_TYPE_NORMAL);

  this.aContentType = aContentType;
  this.aContentLocation = aContentLocation;
  this.aRequestOrigin = aRequestOrigin;
  this.aContext = aContext;
  this.aMimeTypeGuess = aMimeTypeGuess;
  this.aExtra = aExtra;
  this.aRequestPrincipal = aRequestPrincipal;

  this.shouldLoadResult = undefined;
}
NormalRequest.prototype = Object.create(Request.prototype);
NormalRequest.prototype.constructor = Request;

Object.defineProperty(NormalRequest.prototype, "originUriObj", {
  get: function() {
    return this.aRequestOrigin;
  },
});

Object.defineProperty(NormalRequest.prototype, "destUriObj", {
  get: function() {
    return this.aContentLocation;
  },
});

NormalRequest.prototype.setOriginURI = function(originURI) {
  this.originURI = originURI;
  this.aRequestOrigin = DomainUtil.getUriObject(originURI);
};

NormalRequest.prototype.setDestURI = function(destURI) {
  this.destURI = destURI;
  this.aContentLocation = DomainUtil.getUriObject(destURI);
};

Object.defineProperty(NormalRequest.prototype, "destURIWithRef", {
  get: function() {
    return this.aContentLocation.spec;
  },
});

NormalRequest.prototype.getContentPolicyType = function() {
  return this.aContentType;
};

NormalRequest.prototype.detailsToString = function() {
  // Note: try not to cause side effects of toString() during load, so "<HTML
  // Element>" is hard-coded.
  let context = this.aContext instanceof Ci.nsIDOMHTMLElement ?
      "<HTML Element>" : this.aContext;
  return "type: " + this.aContentType +
      ", destination: " + this.destURI +
      ", origin: " + this.originURI +
      ", context: " + context +
      ", mime: " + this.aMimeTypeGuess +
      ", " + this.aExtra;
};

/**
  * Determines if a request is only related to internal resources.
  *
  * @return {Boolean} true if the request is only related to internal
  *         resources.
  */
NormalRequest.prototype.isInternal = function() {
  let rv = Request.prototype.isInternal.call(this);
  if (rv === true) {
    return true;
  }

  // If there are entities in the document, they may trigger a local file
  // request. We'll only allow requests to .dtd files, though, so we don't
  // open up all file:// destinations.
  if (this.aContentLocation.scheme === "file" &&
      this.aContentType === Ci.nsIContentPolicy.TYPE_DTD) {
    return true;
  }

  return false;
};

/**
 * Get the content window (nsIDOMWindow) related to this request.
 *
 * @return {?Window}
 */
NormalRequest.prototype.getContentWindow = function() {
  let context = this.aContext;
  if (!context) {
    return null;
  }

  if (context instanceof Ci.nsIDOMXULElement &&
      context.localName === "browser") {
    return context.contentWindow;
  }

  let win;
  try {
    // eslint-disable-next-line new-cap
    win = context.QueryInterface(Ci.nsIDOMWindow);
  } catch (e) {
    let doc;
    try {
      // eslint-disable-next-line new-cap
      doc = context.QueryInterface(Ci.nsIDOMDocument);
    } catch (e) {
      try {
        // eslint-disable-next-line new-cap
        doc = context.QueryInterface(Ci.nsIDOMNode).ownerDocument;
      } catch (e) {
        return null;
      }
    }
    win = doc.defaultView;
  }
  return win;
};

/**
 * Get the chrome window related to this request.
 *
 * @return {?nsIDOMWindow}
 */
NormalRequest.prototype.getChromeWindow = function() {
  let contentWindow = this.getContentWindow();
  if (contentWindow) {
    return WindowUtils.getChromeWindow(contentWindow);
  } else {
    return null;
  }
};

/**
 * Get the <browser> related to this request.
 *
 * @return {nsIDOMXULElement}
 */
NormalRequest.prototype.getBrowser = function() {
  let context = this.aContext;
  if (context instanceof Ci.nsIDOMXULElement &&
      context.localName === "browser") {
    return context;
  } else {
    return WindowUtils.getBrowserForWindow(this.getContentWindow());
  }
};

// =============================================================================
// RedirectRequest
// =============================================================================

export function RedirectRequest(aOldChannel, aNewChannel, aFlags) {
  let oldChannel = new HttpChannelWrapper(aOldChannel);
  let newChannel = new HttpChannelWrapper(aNewChannel);
  Request.call(this, oldChannel.uri.specIgnoringRef,
               newChannel.uri.specIgnoringRef, REQUEST_TYPE_REDIRECT);
  this._oldChannel = oldChannel;
  this._newChannel = newChannel;
  this._redirectFlags = aFlags;
}
RedirectRequest.prototype = Object.create(Request.prototype);
RedirectRequest.prototype.constructor = Request;

Object.defineProperty(RedirectRequest.prototype, "browser", {
  get: function() {
    return this._oldChannel.browser;
  },
});

Object.defineProperty(RedirectRequest.prototype, "loadFlags", {
  get: function() {
    return this._oldChannel._httpChannel.loadFlags;
  },
});

Object.defineProperty(RedirectRequest.prototype, "originUriObj", {
  get: function() {
    return this._oldChannel.uri;
  },
});

Object.defineProperty(RedirectRequest.prototype, "destUriObj", {
  get: function() {
    return this._newChannel.uri;
  },
});

Object.defineProperty(RedirectRequest.prototype, "destURIWithRef", {
  get: function() {
    return this._newChannel.uri.spec;
  },
});

RedirectRequest.prototype.getContentPolicyType = function() {
  let {loadInfo} = this._oldChannel._httpChannel;
  if (!loadInfo) return Ci.nsIContentPolicy.TYPE_OTHER;
  if (typeof loadInfo.contentPolicyType !== "undefined") {
    // FF < 44.0
    return loadInfo.contentPolicyType;
  }
  return loadInfo.externalContentPolicyType;
};
