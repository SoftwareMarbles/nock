/**
 * @module nock/intercepts
 */

var RequestOverrider = require('./request_overrider'),
    mixin            = require('./mixin'),
    path             = require('path'),
    url              = require('url'),
    inherits         = require('util').inherits,
    EventEmitter     = require('events').EventEmitter,
    http             = require('http'),
    parse            = require('url').parse,
    ClientRequest    = http.ClientRequest,
    _                = require('lodash');

/**
 * @name NetConnectNotAllowedError
 * @private
 * @desc Error trying to make a connection when disabled external access.
 * @class
 * @example
 * nock.disableNetConnect();
 * http.get('http://zombo.com');
 * // throw NetConnectNotAllowedError
 */
function NetConnectNotAllowedError(host) {
  this.message = 'Nock: Not allow net connect for "' + host + '"';
  this.name    = 'NetConnectNotAllowedError';
}

var allInterceptors = {},
    allowNetConnect = /.*/;

/**
 * Enabled real request.
 * @public
 * @param {String|RegExp} matcher=RegExp.new('.*') Expression to match
 * @example
 * // Enables all real requests
 * nock.enableNetConnect();
 * @example
 * // Enables real requests for url that matches google
 * nock.enableNetConnect('google');
 * @example
 * // Enables real requests for url that matches google and amazon
 * nock.enableNetConnect(/(google|amazon)/);
 */
function enableNetConnect(matcher) {
  if (typeof matcher === 'string') {
    allowNetConnect = new RegExp(matcher);
  } else if (typeof matcher === 'object' && typeof matcher.test === 'function') {
    allowNetConnect = matcher;
  } else {
    allowNetConnect = /.*/;
  }
}

function isEnabledForNetConnect(options) {
  normalizeForRequest(options);

  return allowNetConnect && allowNetConnect.test(options.host);
}

/**
 * Disable all real requests.
 * @public
 * @param {String|RegExp} matcher=RegExp.new('.*') Expression to match
 * @example
 * nock.disableNetConnect();
*/
function disableNetConnect() {
  allowNetConnect = false;
}

function isOn() {
  return !isOff();
}

function isOff() {
  return process.env.NOCK_OFF === 'true';
}

function add(key, interceptor, scope, scopeOptions) {
  if (! allInterceptors.hasOwnProperty(key)) {
    allInterceptors[key] = [];
  }
  interceptor.__nock_scope = scope;
  //  HACK: We need scope's key and scope options for scope filtering function (if defined)
  interceptor.__nock_scopeKey = key;
  interceptor.__nock_scopeOptions = scopeOptions;
  allInterceptors[key].push(interceptor);
}

function remove(interceptor) {

  if (interceptor.__nock_scope.shouldPersist()) return;

  if (interceptor.counter > 1) {
    interceptor.counter -= 1;
    return;
  }

  var key          = interceptor._key.split(' '),
      u            = url.parse(key[1]),
      hostKey      = u.protocol + '//' + u.host,
      interceptors = allInterceptors[hostKey],
      interceptor,
      thisInterceptor;

  if (interceptors) {
    for(var i = 0; i < interceptors.length; i++) {
      thisInterceptor = interceptors[i];
      if (thisInterceptor === interceptor) {
        interceptors.splice(i, 1);
        break;
      }
    }

  }
}

function removeAll() {
  allInterceptors = {};
}

function normalizeForRequest(options) {
  options.proto = options.proto || 'http';
  options.port = options.port || ((options.proto === 'http') ? 80 : 443);
  if (options.host) {
    options.hostname = options.hostname || options.host.split(':')[0];
  }
  options.host = (options.hostname || 'localhost') + ':' + options.port;

  return options;
}

function interceptorsFor(options) {
  var basePath;

  normalizeForRequest(options);

  basePath = options.proto + '://' + options.host;

  //  HACK: First try to use scopeFiltering if any of the interceptors has it defined.
  var matchingInterceptor;
  _.each(allInterceptors, function(interceptor, key) {
    _.each(interceptor, function(scope) {
      var scopeFiltering = scope.__nock_scopeOptions.scopeFiltering;
      //  If scope filtering function is defined and returns a truthy value
      //  then we have to treat this as a match.
      if(scopeFiltering && scopeFiltering(basePath)) {
        //  Keep the filtered scope (its key) to signal the rest of the module
        //  that this wasn't an exact but filtered match.
        scope.__nock_filteredScope = scope.__nock_scopeKey;
        matchingInterceptor = interceptor;
        //  Break out of _.each for scopes.
        return false;
      }
    });

    //  Returning falsy value here (which will happen if we have found our matching interceptor)
    //  will break out of _.each for all interceptors.
    return !matchingInterceptor;
  });

  if(matchingInterceptor) {
    return matchingInterceptor;
  }

  return allInterceptors[basePath] || [];
}


function activate() {
  // ----- Extending http.ClientRequest

  function OverridenClientRequest(options, cb) {
    var interceptors = interceptorsFor(options);

    if (interceptors.length) {
      var overrider = RequestOverrider(this, options, interceptors, remove, cb);
      for(var propName in overrider) {
        if (overrider.hasOwnProperty(propName)) {
          this[propName] = overrider[propName];
        }
      }
    } else {
      ClientRequest.apply(this, arguments);
    }

  }
  inherits(OverridenClientRequest, ClientRequest);

  http.ClientRequest = OverridenClientRequest;

  // ----- Overriding http.request and https.request:

  [ 'http', 'https'].forEach(
    function(proto) {

      var moduleName = proto, // 1 to 1 match of protocol and module is fortunate :)
          module = require(moduleName),
          oldRequest = module.request;

      module.request = function(options, callback) {

        var interceptors,
            req,
            res;

        if (typeof options === 'string') { options = parse(options); }
        options.proto = proto;
        interceptors = interceptorsFor(options);

        if (isOn() && interceptors.length) {

          var matches = false,
              allowUnmocked = false;

          interceptors.forEach(function(interceptor) {
            if (! allowUnmocked && interceptor.options.allowUnmocked) { allowUnmocked = true; }
            if (interceptor.matchIndependentOfBody(options)) { matches = true; }
          });

          if (! matches && allowUnmocked) {
            return oldRequest.apply(module, arguments);
          }

          req = new OverridenClientRequest(options);

          res = RequestOverrider(req, options, interceptors, remove);
          if (callback) {
            res.on('response', callback);
          }
          return req;
        } else {
          if (isOff() || isEnabledForNetConnect(options)) {
            return oldRequest.apply(module, arguments);
          } else {
            throw new NetConnectNotAllowedError(options.host);
          }
        }
      };
    }
  );
}

activate();

module.exports = add;
module.exports.removeAll = removeAll;
module.exports.isOn = isOn;
module.exports.activate = activate;
module.exports.enableNetConnect = enableNetConnect;
module.exports.disableNetConnect = disableNetConnect;
