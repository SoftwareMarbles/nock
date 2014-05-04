
/**
 * Normalizes the request options so that it always has `host` property.
 *
 * @param  {Object} options - the parsed options object of the request
 */
var normalizeRequestOptions = function(options) {
  options.proto = options.proto || 'http';
  options.port = options.port || ((options.proto === 'http') ? 80 : 443);
  if (options.host) {
    options.hostname = options.hostname || options.host.split(':')[0];
  }
  options.host = (options.hostname || 'localhost') + ':' + options.port;

  return options;
};

exports.normalizeRequestOptions = normalizeRequestOptions;
