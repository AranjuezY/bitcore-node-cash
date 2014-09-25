/**
 * bitcoind.js
 * Copyright (c) 2014, BitPay (MIT License)
 * A bitcoind node.js binding.
 */

var net = require('net');
var EventEmitter = require('events').EventEmitter;
var bitcoindjs = require('../build/Release/bitcoindjs.node');
var util = require('util');
var net = require('net');
var bn = require('bn.js');

/**
 * Bitcoin
 */

function Bitcoin(options) {
  var self = this;

  if (!(this instanceof Bitcoin)) {
    return new Bitcoin(options);
  }

  EventEmitter.call(this);

  this.options = options;
}

Bitcoin.prototype.__proto__ = EventEmitter.prototype;

Bitcoin.prototype.start = function(callback) {
  var self = this;

  var none = {};
  var isSignal = {};
  var sigint = { name: 'SIGINT', signal: isSignal };
  var sighup = { name: 'SIGHUP', signal: isSignal };
  var sigquit = { name: 'SIGQUIT', signal: isSignal };
  var exitCaught = none;
  var errorCaught = none;

  this.log_pipe = bitcoindjs.start(function(err, status) {
    [sigint, sighup, sigquit].forEach(function(signal) {
      process.on(signal.name, signal.listener = function() {
        if (process.listeners(signal.name).length > 1) {
          return;
        }
        if (!self._shutdown) {
          process.exit(0);
        } else {
          self.stop();
          exitCaught = signal;
        }
      });
    });

    var exit = process.exit;
    self._exit = function() {
      return exit.apply(process, arguments);
    };

    process.exit = function(code) {
      exitCaught = code || 0;
      if (!self._shutdown) {
        return self._exit(code);
      }
      self.stop();
    };

    process.on('uncaughtException', function(err) {
      if (process.listeners('uncaughtException').length > 1) {
        return;
      }
      errorCaught = err;
      if (!self._shutdown) {
        if (err && err.stack) {
          console.error(err.stack);
        }
        self._exit(1);
        return;
      }
      self.stop();
    });

    if (callback) {
      callback(err);
      callback = null;
    }

    if (err) {
      self.emit('error', err);
    } else {
      self.emit('open', status);
    }
  });

  // bitcoind's boost threads aren't in the thread pool
  // or on node's event loop, so we need to keep node open.
  this._shutdown = setInterval(function() {
    if (!self._stoppingSaid && bitcoindjs.stopping()) {
      self._stoppingSaid = true;
      self.log('shutting down...');
    }

    if (bitcoindjs.stopped()) {
      self.log('shut down.');

      clearInterval(self._shutdown);
      delete self._shutdown;

      if (exitCaught !== none) {
        if (exitCaught.signal === isSignal) {
          process.removeListener(exitCaught.name, exitCaught.listener);
          setImmediate(function() {
            process.kill(process.pid, exitCaught.name);
          });
          return;
        }
        return self._exit(exitCaught);
      }

      if (errorCaught !== none) {
        if (errorCaught && errorCaught.stack) {
          console.error(errorCaught.stack);
        }
        return self._exit(0);
      }
    }
  }, 1000);

  this.pollInterval = 300;

  this._emitted = {};

  this.on('newListener', function(name) {
    if (name === 'block') {
      self._pollBlocks();
      return;
    }
    if (name === 'tx') {
      self._pollBlocks();
      self._pollMempool();
      return;
    }
    if (name === 'mptx') {
      self._pollMempool();
      return;
    }
  });

  if (this.log_pipe !== -1) {
    this.log('log pipe opened: %d', this.log_pipe);
    this._pipe = new net.Socket(this.log_pipe);
    this._pipe.on('data', function(data) {
      return process.stdout.write('bitcoind: ' + data + '\n');
    });
    this._pipe.on('error', function(err) {
      ; // ignore for now
    });
    this._pipe.resume();
  }
};

Bitcoin.prototype._pollBlocks = function() {
  var self = this;
  if (this._pollingBlocks) return;
  this._pollingBlocks = true;
  (function next() {
    return bitcoindjs.pollBlocks(function(err, blocks) {
      if (err) return setTimeout(next, self.pollInterval);
      return utils.forEach(blocks, function(block, nextBlock) {
        // XXX Bad workaround
        if (self._emitted[block.hash]) {
          return setImmediate(function() {
            return nextBlock();
          });
        }
        self._emitted[block.hash] = true;

        self.emit('block', block);

        return utils.forEach(block.tx, function(tx, nextTx) {
          self.emit('tx', tx);
          return setImmediate(function() {
            return nextTx();
          });
        }, function() {
          return setImmediate(function() {
            return nextBlock();
          });
        });
      }, function() {
        return setTimeout(next, self.pollInterval);
      });
    });
  })();
};

Bitcoin.prototype._pollMempool = function() {
  var self = this;
  if (this._pollingMempool) return;
  this._pollingMempool = true;
  (function next() {
    return bitcoindjs.pollMempool(function(err, txs) {
      if (err) return setTimeout(next, self.pollInterval);
      return utils.forEach(txs, function(tx, nextTx) {
        // XXX Bad workaround
        if (self._emitted[tx.hash]) {
          return setImmediate(function() {
            return nextTx();
          });
        }
        self._emitted[tx.hash] = true;

        self.emit('mptx', tx);
        self.emit('tx', tx);

        return setImmediate(function() {
          return nextTx();
        });
      }, function() {
        return setTimeout(next, self.pollInterval);
      });
    });
  })();
};

Bitcoin.prototype.getBlock = function(blockHash, callback) {
  return bitcoindjs.getBlock(blockHash, callback);
};

Bitcoin.prototype.getTx = function(txHash, blockHash, callback) {
  if (!callback) {
    callback = blockHash;
    blockHash = '';
  }

  // if (txHash[1] === 'x') txHash = txHash.slice(2);
  // txHash = utils.revHex(txHash);

  // if (blockHash) {
  //   if (blockHash[1] === 'x') blockHash = blockHash.slice(2);
  //   blockHash = utils.revHex(blockHash);
  // }

  return bitcoindjs.getTx(txHash, blockHash, callback);
};

Bitcoin.prototype.log =
Bitcoin.prototype.info = function() {
  if (typeof arguments[0] !== 'string') {
    var out = util.inspect(arguments[0], null, 20, true);
    return process.stdout.write('bitcoind.js: ' + out + '\n');
  }
  var out = util.format.apply(util, arguments);
  return process.stdout.write('bitcoind.js: ' + out + '\n');
};

Bitcoin.prototype.error = function() {
  if (typeof arguments[0] !== 'string') {
    var out = util.inspect(arguments[0], null, 20, true);
    return process.stderr.write('bitcoind.js: ' + out + '\n');
  }
  var out = util.format.apply(util, arguments);
  return process.stderr.write('bitcoind.js: ' + out + '\n');
};

Bitcoin.prototype.stop =
Bitcoin.prototype.close = function(callback) {
  var self = this;
  return bitcoindjs.stop(function(err, status) {
    if (err) {
      self.error(err.message);
    } else {
      self.log(status);
    }
    if (!callback) return;
    return callback(err, status);
  });
};

/**
 * Block
 */

function Block(data) {
  if (!(this instanceof Block)) {
    return new Block(data);
  }
}

/**
 * Transaction
 */

function Transaction(data) {
  if (!(this instanceof Transaction)) {
    return new Transaction(data);
  }

  this.nMinTxFee = data.nMinTxFee || new bn(0);
  this.nMinRelayTxFee = data.nMinRelayTxFee || new bn(0);
  this.CURRENT_VERSION = 1;
  this.nVersion = data.nVersion || -1;
  this.vin = data.vin || [];
  this.vout = data.vout || [];
  this.nLockTime = data.nLockTime || null;
}

Transaction.prototype.getSerializeSize = function() {
  ;
};

Transaction.prototype.serialize = function() {
  ;
};

Transaction.prototype.unserialize = function() {
  ;
};

Transaction.prototype.setNull = function() {
  ;
};

Transaction.prototype.isNull = function() {
  ;
};

Transaction.prototype.getHash = function() {
  ;
};

Transaction.prototype.getValueOut = function() {
  ;
};

Transaction.prototype.computePriority = function() {
  ;
};

Transaction.prototype.isCoinbase = function() {
  ;
};

Transaction.prototype.equal = function() {
  ;
};

Transaction.prototype.notEqual = function() {
  ;
};

Transaction.prototype.toString = function() {
  ;
};

Transaction.prototype.print = function() {
  ;
};

/**
 * Utils
 */

var utils = {};

utils.revHex = function revHex(s) {
  var r = '';
  for (var i = 0; i < s.length; i += 2) {
    r = s.slice(i, i + 2) + r;
  }
  return r;
};

utils.forEach = function(obj, iter, done) {
  var pending = obj.length;
  if (!pending) return done();
  var next = function() {
    if (!--pending) done();
  };
  obj.forEach(function(item) {
    iter(item, next);
  });
};

/**
 * Expose
 */

module.exports = exports = Bitcoin;
exports.Bitcoin = Bitcoin;
exports.native = bitcoindjs;
exports.utils = utils;