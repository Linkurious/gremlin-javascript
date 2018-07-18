/*jslint -W079 */
/*jslint node: true */
'use strict';
var EventEmitter = require('events').EventEmitter;
var inherits = require('util').inherits;

var WebSocket = require('ws');
var uuid = require('node-uuid');
var _ = {
  defaults: require('lodash/object/defaults')
};
var highland = require('highland');

var MessageStream = require('./messagestream');


var executeHandler = require('./executehandler');

function GremlinClient(port, host, options) {
  this.port = port || 8182;
  this.host = host || 'localhost';

  this.options = _.defaults(options || {}, {
    path: '',
    language: 'gremlin-groovy',
    session: false,
    op: 'eval',
    processor: '',
    accept: 'application/json',
    executeHandler: executeHandler,
    ssl: false,
    rejectUnauthorized: false
  });
  
  this.path = this.options.path;

  this.useSession = this.options.session;

  if (this.useSession) {
    this.sessionId = uuid.v1();
  }

  this.connected = false;
  this.queue = [];

  this.commands = {};
  this.lastAuthenticationReqId = null;

  this.protocol = this.options.ssl ? 'wss://' : 'ws://';

  // Open websocket connection
  this.ws = new WebSocket(this.protocol + this.host +':'+ this.port + this.path,
      undefined,
      {
        rejectUnauthorized: this.options.rejectUnauthorized
      }
  );

  this.ws.onopen = this.onConnectionOpen.bind(this);

  this.ws.onerror = function(e) {
    console.log('Error:', e);
  };

  this.ws.onmessage = this.handleMessage.bind(this);

  this.ws.onclose = this.handleDisconnection.bind(this);
}

inherits(GremlinClient, EventEmitter);

/**
 * Process all incoming raw message events sent by Gremlin Server, and dispatch
 * to the appropriate command.
 *
 * @param {MessageEvent} event
 */
GremlinClient.prototype.handleMessage = function(event) {
  var rawMessage = JSON.parse(event.data || event); // Node.js || Browser API
  if (this.lastAuthenticationReqId !== null) {
    var requestId = this.lastAuthenticationReqId;
    this.lastAuthenticationReqId = null;
  } else {
    var requestId = rawMessage.requestId;
  }
  var command = this.commands[requestId];

  if (command === undefined || command === null) {
    // If there was no command for this response, just ignore the response
    return;
  }

  var statusCode = rawMessage.status.code;
  var messageStream = command.messageStream;

  switch (statusCode) {
    case 200: // SUCCESS
      delete this.commands[requestId];
      messageStream.push(rawMessage);
      messageStream.push(null);
      break;
    case 204: // NO_CONTENT
      delete this.commands[requestId];
      messageStream.push(null);
      break;
    case 206: // PARTIAL_CONTENT
      messageStream.push(rawMessage);
      break;
    default:
      delete this.commands[requestId];
      messageStream.emit('error', new Error(rawMessage.status.message + ' (Error '+ statusCode +')'));
      break;
  }
};

/**
 * Handle the WebSocket onOpen event, flag the client as connected and
 * process command queue.
 */
GremlinClient.prototype.onConnectionOpen = function() {
  this.connected = true;
  this.emit('connect');

  this.executeQueue();
};

/**
 * @param {CloseEvent} event
 */
GremlinClient.prototype.handleDisconnection = function(event) {
  this.cancelPendingCommands({
    message: 'WebSocket closed',
    details: event
  });
};

/**
 * Process the current command queue, sending commands to Gremlin Server
 * (First In, First Out).
 */
GremlinClient.prototype.executeQueue = function() {
  var command;

  while (this.queue.length > 0) {
    command = this.queue.shift();
    this.sendMessage(command.message);
  }
};

/**
 * @param {Object} reason
 */
GremlinClient.prototype.cancelPendingCommands = function(reason) {
  var commands = this.commands;
  var command;
  var error = new Error(reason.message);
  error.details = reason.details;

  // Empty queue
  this.queue.length = 0;
  this.commands = {};

  Object.keys(commands).forEach(function(key) {
    command = commands[key];
    command.messageStream.emit('error', error);
  });
};

/**
 * For a given script string and optional bound parameters, build a command
 * object to be sent to Gremlin Server.
 *
 * @param {String|Function} script
 * @param {Object} bindings
 * @param {Object} message
 */
GremlinClient.prototype.buildCommand = function(script, bindings, message) {
  if (typeof script === 'function') {
    script = this.extractFunctionBody(script);
  }
  bindings = bindings || {};

  var messageStream = new MessageStream({ objectMode: true });
  var guid = uuid.v1();
  var args = _.defaults(message && message.args || {}, {
    gremlin: script,
    bindings: bindings,
    accept: this.options.accept,
    language: this.options.language,
    binary: false
  });

  message = _.defaults(message || {}, {
    requestId: guid,
    processor: this.options.processor,
    op: this.options.op,
    args: args
  });

  var command = {
    message: message,
    messageStream: messageStream
  };

  if (this.useSession) {
    // Assume that people want to use the 'session' processor unless specified
    command.message.processor = message.processor || this.options.processor || 'session';
    command.message.args.session = this.sessionId;
  }

  return command;
};

GremlinClient.prototype.packMessageToBinary = function(message) {
  var serializedMessage = message.args.accept + JSON.stringify(message);
  serializedMessage = unescape(encodeURIComponent(serializedMessage));

  // Let's start packing the message into binary
  // mimeLength(1) + mimeType Length + serializedMessage Length
  var binaryMessage = new Uint8Array(1 + serializedMessage.length);
  binaryMessage[0] = this.options.accept.length;

  for (let i = 0; i < serializedMessage.length; i++) {
    binaryMessage[i + 1] = serializedMessage.charCodeAt(i);
  }

  return binaryMessage;
}

GremlinClient.prototype.sendMessage = function(message) {
  var formatedMessage = message.args.binary
    ? this.packMessageToBinary(message)
    : JSON.stringify(message);

  this.ws.send(formatedMessage);
};

/**
 * Get the inner function body from a function.toString() representation
 *
 * @param {Function}
 * @return {String}
 */
GremlinClient.prototype.extractFunctionBody = function(fn) {
  var body = fn.toString();
  body = body.substring(body.indexOf('{') + 1, body.lastIndexOf('}'));

  return body;
};

/**
 * Asynchronously send a script to Gremlin Server for execution and fire
 * the provided callback when all results have been fetched.
 *
 * This method internally uses a stream to handle the potential concatenation
 * of results.
 *
 * Callback signature: (Error, Array<result>)
 *
 * @public
 * @param {String|Function} script
 * @param {Object} bindings
 * @param {Object} message
 * @param {Function} callback
 */
GremlinClient.prototype.execute = function(script, bindings, message, callback) {
  callback = arguments[arguments.length - 1]; //todo: improve?

  if (typeof message === 'function') {
    callback = message;
    message = {};
  }

  var messageStream = this.messageStream(script, bindings, message);

  // TO CHECK: errors handling could be improved
  // See https://groups.google.com/d/msg/nodejs/lJYT9hZxFu0/L59CFbqWGyYJ
  // for an example using domains
  var executeHandler = this.options.executeHandler;

  executeHandler(messageStream, callback);
};

/**
 * Execute the script and return a stream of distinct/single results.
 * This method reemits a distinct data event for each returned result, which
 * makes the stream behave as if `resultIterationBatchSize` was set to 1.
 *
 * If you do not wish this behavior, please use client.messageStream() instead.
 *
 * Even though this method uses Highland.js internally, it does not return
 * a high level Highland readable stream so we do not risk having to deal
 * with unexpected API breaking changes as Highland.js evolves.
 *
 * @return {ReadableStream} A Node.js Stream2
 */
GremlinClient.prototype.stream = function(script, bindings, message) {
  var messageStream = this.messageStream(script, bindings, message);
  var _ = highland; // override lo-dash locally

  // Create a local highland 'through' pipeline so we don't expose
  // a Highland stream to the end user, but a standard Node.js Stream2
  var through = _.pipeline(
    _.map(function(message) {
      return message.result.data;
    }),
    _.sequence()
  );

  var stream = messageStream.pipe(through);

  messageStream.on('error', function(e) {
    stream.emit('error', new Error(e));
  });

  return stream;
};

/**
 * Execute the script and return a stream of raw messages returned by Gremlin
 * Server.
 * This method does not reemit one distinct data event per result. It directly
 * emits the raw messages returned by Gremlin Server as they are received.
 *
 * Although public, this is a low level method intended to be used for
 * advanced usages.
 *
 * @public
 * @param {String|Function} script
 * @param {Object} bindings
 * @param {Object} message
 * @return {MessageStream}
 */
GremlinClient.prototype.messageStream = function(script, bindings, message) {
  var command = this.buildCommand(script, bindings, message);

  this.sendCommand(command); //todo improve for streams

  return command.messageStream;
};

/**
 * Send a command to Gremlin Server, or add it to queue if the connection
 * is not established.
 *
 * @param {Object} command
 */
GremlinClient.prototype.sendCommand = function(command) {
  this.commands[command.message.requestId] = command;

  if (command.message.op === 'authentication') {
    this.lastAuthenticationReqId = command.message.requestId;
  }

  if (this.connected) {
    this.sendMessage(command.message);
  } else {
    this.queue.push(command);
  }
};

module.exports = GremlinClient;
