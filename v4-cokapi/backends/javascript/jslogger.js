/*

JS logger backend for Online Python Tutor runtime visualizer

First version created on: 2015-01-02 by Philip Guo

Run as:
node --expose-debug-as=Debug jslogger.js

Usage:

# to output trace as 'var trace=<trace object>' to a JavaScript file, run:
node --expose-debug-as=Debug jslogger.js --jsfile=<path> <filename of user's script>

# to dump compact json to stdout, run:
node --expose-debug-as=Debug jslogger.js --jsondump=true <filename of user's script>

# to dump a pretty-printed version suitable for diffing and regression tests
node --expose-debug-as=Debug jslogger.js --prettydump=true <filename of user's script>

# to run with a script provided on the command line, run something like:
node --expose-debug-as=Debug jslogger.js --jsondump=true --code="<user's script>"
 
see v8/src/debug-debugger.js for some of the impl of the API

v8 debugger protocol:
https://code.google.com/p/v8-wiki/wiki/DebuggerProtocol

Prereqs:
npm install eval
npm install underscore
npm install esprima
npm install minimist


From: https://code.google.com/p/v8-wiki/wiki/DebuggerProtocol
regarding the 'handle_' field of serialized objects ...

  All objects exposed through the debugger is assigned an ID called a
  handle. This handle is serialized and can be used to identify objects.
  A handle has a certain lifetime after which it will no longer refer to
  the same object. Currently the lifetime of handles match the
  processing of a debug event. For each debug event handles are
  recycled.


TODOs:


Low-priority TODOs:

- maybe directly use vm.runInContext
- realize that running within VM module leads to subtle behavioral
  differences, as documented in the Node docs

- check out PromiseEvent and AsyncTaskEvent for maybe handling callbacks?

Debug.DebugEvent = { Break: 1,
                     Exception: 2,
                     NewFunction: 3,
                     BeforeCompile: 4,
                     AfterCompile: 5,
                     CompileError: 6,
                     PromiseEvent: 7,
                     AsyncTaskEvent: 8,
                     BreakForCommand: 9 };

*/


/*jshint node: true */
/* global Debug */
"use strict";

var _eval = require('eval');
var esprima = require('esprima');
var util = require('util');
var fs = require('fs');
var _ = require('underscore');
var debug = Debug.Debug;

var log = console.warn; // use stderr because stdout is being captured in the trace


var argv = require('minimist')(process.argv.slice(2));


var IGNORE_GLOBAL_VARS = {'ArrayBuffer': true,
                          'Int8Array': true,
                          'Uint8Array': true,
                          'Uint8ClampedArray': true,
                          'Int16Array': true,
                          'Uint16Array': true,
                          'Int32Array': true,
                          'Uint32Array': true,
                          'Float32Array': true,
                          'Float64Array': true,
                          'DataView': true,
                          'DTRACE_NET_SERVER_CONNECTION': true,
                          'DTRACE_NET_STREAM_END': true,
                          'DTRACE_NET_SOCKET_READ': true,
                          'DTRACE_NET_SOCKET_WRITE': true,
                          'DTRACE_HTTP_SERVER_REQUEST': true,
                          'DTRACE_HTTP_SERVER_RESPONSE': true,
                          'DTRACE_HTTP_CLIENT_REQUEST': true,
                          'DTRACE_HTTP_CLIENT_RESPONSE': true,
                          'global': true,
                          'process': true,
                          'GLOBAL': true,
                          'root': true,
                          'Buffer': true,
                          'setTimeout': true,
                          'setInterval': true,
                          'clearTimeout': true,
                          'clearInterval': true,
                          'setImmediate': true,
                          'clearImmediate': true,
                          'console': true,
                          'require': true,
                          'exports': true,
                          'module': true};


var MAX_EXECUTED_LINES = 300;

String.prototype.rtrim = function() {
  return this.replace(/\s*$/g, "");
};

// for some reason, stderr is borked when running under the node
// debugger, so we must print to stdout. the node 'assert' module fails
// silently :/
function assert(cond) {
  if (!cond) {
    var stack = new Error().stack;
    log('Assertion error');
    log(stack);
    throw 'Assertion Failure';
  }
}


function wrapUserscript(userscript) {
  var s = "\"use strict\";\ndebugger;\n";
  s += userscript.rtrim();
  return s;
}


var originalStdout = process.stdout.write;
var fauxStdout = [];

function redirectStdout() {
  process.stdout.write = function(string) {
    fauxStdout.push(string);
  };
}

function resetStdout() {
  process.stdout.write = originalStdout;
}

function fauxStdoutToString() {
  return fauxStdout.join('');
}


// Key: string form of f.details_.frameId()
// Value: integer number of times called
//
// because v8 reuses frame objects (presumably for optimizations), we
// must munge frame IDs based on the number of times a function was
// called. every time a function RETURNS, increment the call count by 1
var frameIdCalls = {};

var curSmallId = 1;
var frameIdToSmallIds = {};

function getCanonicalFrameId(frame) {
  var baseFrameId = String(frame.details_.frameId()); // don't forget to stringify!
  var realFrameId = baseFrameId;
  if (frameIdCalls[baseFrameId] !== undefined) {
    realFrameId = baseFrameId + '_' + String(frameIdCalls[baseFrameId]);
  }

  // now canonicalize
  if (frameIdToSmallIds[realFrameId] === undefined) {
    frameIdToSmallIds[realFrameId] = curSmallId++;
  }

  return frameIdToSmallIds[realFrameId];
}

function encodeToplevelObject(o) {
  return encodeObject(o.value_);
}

var smallObjId = 1;

// Key: string form of smallObjId
// Value: encoded (compound) heap object
var encodedHeapObjects = {};

function getHeap() {
  return encodedHeapObjects;
}

function resetHeap() {
  // VERY IMPORTANT to reassign to an empty object rather than just
  // clearing the existing object, since getHeap() could have been
  // called earlier to return a reference to a previous heap state
  encodedHeapObjects = {};
}

// modeled after:
// https://github.com/pgbovine/OnlinePythonTutor/blob/master/v3/pg_encoder.py
//
// modifies global encodedHeapObjects
function encodeObject(o) {
  if (_.isNumber(o)) {
    if (_.isNaN(o)) {
      return ['SPECIAL_FLOAT', 'NaN'];
    } else if (o === Infinity) {
      return ['SPECIAL_FLOAT', 'Infinity'];
    } else if (o === -Infinity) {
      return ['SPECIAL_FLOAT', '-Infinity'];
    } else {
      return o;
    }
  } else if (_.isString(o)) {
    return o;
  } else if (_.isBoolean(o) || _.isNull(o) || _.isUndefined(o)) {
    return ['JS_SPECIAL_VAL', String(o)];
  } else {
    // render these as heap objects

    // very important to use _.has since we don't want to
    // grab the property in your prototype, only in YOURSELF ... SUBTLE!
    if (!_.has(o, 'smallObjId_hidden_')) {
      // make this non-enumerable so that it doesn't show up in
      // console.log() or other inspector functions
      Object.defineProperty(o, 'smallObjId_hidden_', { value: smallObjId,
                                                       enumerable: false });
      smallObjId++;
    }
    assert(o.smallObjId_hidden_ > 0);

    var ret = ['REF', o.smallObjId_hidden_];

    if (encodedHeapObjects[String(o.smallObjId_hidden_)] !== undefined) {
      return ret;
    }
    else {
      assert(_.isObject(o));

      var newEncodedObj = [];
      encodedHeapObjects[String(o.smallObjId_hidden_)] = newEncodedObj;

      var i;

      if (_.isFunction(o)) {
        var funcProperties = []; // each element is a pair of [name, encoded value]

        var encodedProto = null;
        if (_.isObject(o.prototype)) {
          // TRICKY TRICKY! for inheritance to be displayed properly, we
          // want to find the prototype of o.prototype and see if it's
          // non-empty. if that's true, then even if o.prototype is
          // empty (i.e., has no properties of its own), then we should
          // still encode it since its 'prototype' "uber-hidden
          // property" is non-empty
          var prototypeOfPrototype = Object.getPrototypeOf(o.prototype);
          if (!_.isEmpty(o.prototype) ||
              (_.isObject(prototypeOfPrototype) && !_.isEmpty(prototypeOfPrototype))) {
            encodedProto = encodeObject(o.prototype);
          }
        }

        if (encodedProto) {
          funcProperties.push(['prototype', encodedProto]);
        }

        // now get all of the normal properties out of this function
        // object (it's unusual to put properties in a function object,
        // but it's still legal!)
        var funcPropPairs = _.pairs(o);
        for (i = 0; i < funcPropPairs.length; i++) {
          funcProperties.push([funcPropPairs[i][0], encodeObject(funcPropPairs[i][1])]);
        }

        var funcCodeString = o.toString();

        /*

        #craftsmanship -- make nested functions look better by indenting
        the first line of a nested function definition by however much
        the LAST line is indented, ONLY if the last line is simply a
        single ending '}'. otherwise it will look ugly since the
        function definition doesn't start out indented, like so:

function bar(x) {
        globalZ += 100;
        return x + y + globalZ;
    }

        */
        var codeLines = funcCodeString.split('\n');
        if (codeLines.length > 1) {
          var lastLine = _.last(codeLines);
          if (lastLine.trim() === '}') {
            var lastLinePrefix = lastLine.slice(0, lastLine.indexOf('}'));
            funcCodeString = lastLinePrefix + funcCodeString; // prepend!
          }
        }

        newEncodedObj.push('JS_FUNCTION',
                           o.name,
                           funcCodeString, /* code string*/
                           funcProperties.length ? funcProperties : null, /* OPTIONAL */
                           null /* parent frame */);
      } else if (_.isArray(o)) {
        newEncodedObj.push('LIST');
        for (i = 0; i < o.length; i++) {
          newEncodedObj.push(encodeObject(o[i]));
        }
      } else {
        // a true object

        // if there's a custom toString() function (note that a truly
        // prototypeless object won't have toString method, so check first to
        // see if toString is *anywhere* up the prototype chain)
        var s = (o.toString !== undefined) ? o.toString() : '';
        if (s !== '' && s !== '[object Object]') {
          newEncodedObj.push('INSTANCE_PPRINT', 'object', s);
        } else {
          newEncodedObj.push('INSTANCE', '');
          var pairs = _.pairs(o);
          for (i = 0; i < pairs.length; i++) {
            var e = pairs[i];
            newEncodedObj.push([encodeObject(e[0]), encodeObject(e[1])]);
          }

          var proto = Object.getPrototypeOf(o);
          if (_.isObject(proto) && !_.isEmpty(proto)) {
            //log('obj.prototype', proto, proto.smallObjId_hidden_);
            // I think __proto__ is the official term for this field,
            // *not* 'prototype'
            newEncodedObj.push(['__proto__', encodeObject(proto)]);
          }
        }
      }

      return ret;
    }

  }
  assert(false);
}


var curTrace = [];

// to detect whether we have a possible function call
var prevStack = null;

function listener(event, execState, eventData, data) {
  var stepType, i, n;
  var ii, jj, sc, scopeType, scopeObj;
  var f;

  // TODO: catch CompileError and maybe other events too
  if (event !== debug.DebugEvent.Break && event !== debug.DebugEvent.Exception) {
    return;
  }

  var isException = (event === debug.DebugEvent.Exception);

  var script   = eventData.func().script().name();
  var line     = eventData.sourceLine() + 1;
  var col      = eventData.sourceColumn();
  assert(line >= 2);
  line -= 2; // to account for wrapUserscript() adding extra lines

  // if what we're currently executing isn't inside of userscript.js,
  // then PUNT, since we're probably in the first line of console.log()
  // or some other utility function (except for exceptions, heh)
  if (script !== 'userscript.js') {
    // this is SUPER hacky ... but if we encounter an exception in a
    // library function AND we've already been running userscript.js
    // (i.e., curTrace.length > 0), then still log that exception but
    // adjust the line and column numbers to the proper values within
    // the user's script.
    if (isException && curTrace.length > 0) {
      stepType = debug.StepAction.StepOut; // step out of the library func

      // SUPER HACKY -- use the line and column numbers from the
      // previous trace entry since that was in userscript.js
      line = _.last(curTrace).line;
      col = _.last(curTrace).col;
    } else {
      // any non-exception event should just be steppd out of
      // immediately without logging to the trace ...
      execState.prepareStep(debug.StepAction.StepOut);
      return;
    }
  } else {
    // NB: StepInMin is slightly finer-grained than StepIn
    stepType = debug.StepAction.StepIn;

    if (line === 0) { // the 'debugger;' line at the beginning of wrapUserscript
      execState.prepareStep(stepType);
      return;
    }
  }

  //assert(script === 'userscript.js');

  // VERY VERY VERY IMPORTANT, or else we won't properly capture heap
  // object mutations in the trace!
  resetHeap();

  var all_userscript_frames = [];


  //log('execState.frameCount', execState.frameCount());

  // only dig up frames in userscript.js
  for (i = 0, n = execState.frameCount(); i < n; i++) {
    f = execState.frame(i);
    var sn = f.func().script().name();

    if (sn === 'userscript.js') {
      all_userscript_frames.push(f);
    }
  }

  if (all_userscript_frames.length > 0) {
    var curTraceEntry = {};

    var logEventType = 'step_line'; // the default until proven otherwise

    var curStack = all_userscript_frames.map(function(f) {return getCanonicalFrameId(f);});
    assert(curStack.length > 0);

    if (prevStack) {
      if (!_.isEqual(prevStack, curStack)) {
        // test whether exactly one extra entry has been pushed to the
        // front; if so, that's our newly-called frame
        if (_.isEqual(prevStack, curStack.slice(1))) {
          logEventType = 'call';
        }
      }
    }
    prevStack = curStack;

    var topFrame = all_userscript_frames[0];
    var topIsReturn = topFrame.isAtReturn();
    if (topIsReturn) {
      // nix this check below since it sometimes happens. see
      // tests/eloquentjs-8.1.js
      //assert(logEventType != 'call'); // shouldn't be a call AND return

      logEventType = 'return';

      // for aesthetics, if we're returning out of a function, set the
      // line number to the PREVIOUS entry's line, since v8 records the
      // line number here as usually where the '}' is in the function,
      // which doesn't look good
      //
      // NB: this hack doesn't work all the time, e.g., when you're
      // returning from more than one function call in short succession
      if (curTrace.length > 0) {
        var prevEntry = curTrace[curTrace.length - 1];
        var prevEntryStack = prevEntry.stack_to_render;
        if (prevEntryStack.length > 0) {
          // do this ONLY IF if we're still in the same frame
          var topFid = getCanonicalFrameId(topFrame);
          if (prevEntryStack[prevEntryStack.length - 1].frame_id === topFid) {
            line = prevEntry.line;
          }
        }
      }
    }

    if (isException) {
      logEventType = 'exception';
      curTraceEntry.exception_msg = String(eventData.exception_);
    }

    curTraceEntry.stdout = fauxStdoutToString();
    curTraceEntry.func_name = topFrame.func().name();
    curTraceEntry.stack_to_render = [];

    curTraceEntry.globals = {};
    curTraceEntry.ordered_globals = [];

    curTraceEntry.line = line;
    curTraceEntry.col = col;
    curTraceEntry.event = logEventType;
    curTraceEntry.heap = getHeap();

    // inspect only the top "global" frame to grab globals
    for (ii = 0; ii < topFrame.scopeCount(); ii++) {
      sc = topFrame.scope(ii);
      // According to https://code.google.com/p/v8-wiki/wiki/DebuggerProtocol
      //
      // 0: Global
      // 1: Local
      // 2: With
      // 3: Closure
      // 4: Catch
      scopeType = sc.details_.details_[0];
      if (scopeType === 0) { // Global -- to handle global variables
        scopeObj = sc.details_.details_[1];
        var globalScopePairs = _.pairs(scopeObj);
        for (jj = 0; jj < globalScopePairs.length; jj++) {
          var globalVarname = globalScopePairs[jj][0];
          var globalVal = globalScopePairs[jj][1];
          if (!_.has(IGNORE_GLOBAL_VARS, globalVarname)) {
            curTraceEntry.ordered_globals.push(globalVarname);
            assert(!_.has(curTraceEntry.globals, globalVarname));
            curTraceEntry.globals[globalVarname] = encodeObject(globalVal);
          }
        }
      }
      else if (scopeType === 4) { // Catch -- to handle global exception blocks
        scopeObj = sc.details_.details_[1];

        var globalCatchScopePairs = _.pairs(scopeObj);
        for (jj = 0; jj < globalCatchScopePairs.length; jj++) {
          var globalCatchVarname = globalCatchScopePairs[jj][0];
          var globalCatchVal = globalCatchScopePairs[jj][1];
          curTraceEntry.ordered_globals.push(globalCatchVarname);
          assert(!_.has(curTraceEntry.globals, globalCatchVarname));
          curTraceEntry.globals[globalCatchVarname] = encodeObject(globalCatchVal);
        }
      }
    }

    for (i = 0;
         i < all_userscript_frames.length - 1; /* last frame is fake 'top-level' frame */
         i++) {
      var traceStackEntry = {};

      f = all_userscript_frames[i];
      assert(f.func().script().name() == 'userscript.js');

      var isConstructorCall = f.isConstructCall();

      var fid = getCanonicalFrameId(f);
      //log(i, 'funcname:', f.func().name(), fid);

      traceStackEntry.func_name = f.func().name();
      traceStackEntry.frame_id = fid;

      if (isConstructorCall) {
        traceStackEntry.func_name += ' (constructor)';
      }

      // TODO: this might not still be correct if we have closures
      traceStackEntry.is_highlighted = (f === topFrame);


      // TODO: implement support for closures
      traceStackEntry.is_parent = false;
      traceStackEntry.is_zombie = false;
      traceStackEntry.parent_frame_id_list = [];

      // TODO: need to modify when we have closures with parent and
      // zombie frames
      traceStackEntry.unique_hash = traceStackEntry.func_name + '_f' + traceStackEntry.frame_id;


      traceStackEntry.ordered_varnames = []; // TODO: how should we sort these?
      traceStackEntry.encoded_locals = {};

      // encode 'this' if it's defined and doesn't point to the
      // pseudo-'global' top-level wrapper in the _eval call:
      var receiver = f.receiver();
      if (receiver.type_ === 'object') {
        var realThis = receiver.value_;

        // sometimes you'll get a weirdo receiver that's an empty object
        // with NO PROTOTYPE ... wtf?!? WTF?!? that's real bad news, so
        // we don't want to try to run encodeObject on it, since it
        // blows the hell up. so skip those bad cases
        var thisProto = Object.getPrototypeOf(realThis);
        if (thisProto) {
          traceStackEntry.ordered_varnames.push('this');
          assert(traceStackEntry.encoded_locals['this'] === undefined);
          traceStackEntry.encoded_locals['this'] = encodeObject(realThis);
        }
      }

      var j, k, v;

      /*

      // This is the OLD DEPRECATED WAY to get args and locals, which is
      // brittle. instead we just grab elements from the Local scope
      // dict below. I suppose one "advantage" of this approach is that
      // you get arguments and locals IN ORDER, so maybe that could be
      // used later to populate ordered_varnames or something. But it's
      // brittle :/

      for (j = 0; j < f.argumentCount(); j++) {
        log('ARG', k, '->', v);
        k = f.argumentName(j);
        v = f.argumentValue(j);

        traceStackEntry.ordered_varnames.push(k);
        assert(traceStackEntry.encoded_locals[k] === undefined);
        traceStackEntry.encoded_locals[k] = encodeToplevelObject(v);
      }

      // always encode arguments BEFORE locals, since there's the
      // possibility that a local and argument with the SAME NAME
      // exists, in which case the local's value should override the
      // argument's value. if you mutate a local, apparently the entry
      // in arguments stays unmodified; interesting
      /*
      for (j = 0; j < f.localCount(); j++) {
        log('LOCAL', k, '->', v);
        k = f.localName(j);
        v = f.localValue(j);

        // don't push a duplicate in case it already appeared in
        // arguments above
        if (!_.contains(traceStackEntry.ordered_varnames, k)) {
          traceStackEntry.ordered_varnames.push(k);
        }

        // will override the earlier entry from arguments if it exists
        traceStackEntry.encoded_locals[k] = encodeToplevelObject(v);
      }
      */

      var nParentScopes = 1;
      for (ii = 0;
           ii < f.scopeCount();
           ii++) {
        sc = f.scope(ii);

        // According to https://code.google.com/p/v8-wiki/wiki/DebuggerProtocol
        //
        // 0: Global
        // 1: Local
        // 2: With
        // 3: Closure
        // 4: Catch
        scopeType = sc.details_.details_[0];
        var e;
        // DON'T grab globals again since it's redundant
        if (scopeType === 1 || scopeType === 4) { // Local or Catch (for exceptions)
          // encode local variables

          scopeObj = sc.details_.details_[1];
          assert(_.isObject(scopeObj));
          var localScopePairs = _.pairs(scopeObj);
          for (jj = 0; jj < localScopePairs.length; jj++) {
            e = localScopePairs[jj];
            traceStackEntry.ordered_varnames.push(e[0]);
            assert(!_.has(traceStackEntry.encoded_locals, e[0]));
            traceStackEntry.encoded_locals[e[0]] = encodeObject(e[1]);
          }
        } else if (scopeType === 2 || scopeType === 3) { // With, Closure
          // poor person's closure display ... simply INLINE closure
          // variables into this frame, since that's what v8 provides us.
          // not as great as drawing real environment diagrams, but
          // whatevers ...
          //
          // as far as i can tell, v8 exposes scope objects, so i can get
          // all the closure vars. but it doesn't tie those scopes to specific
          // function call frames :(
          scopeObj = sc.details_.details_[1];
          assert(_.isObject(scopeObj));
          var parentScopePairs = _.pairs(scopeObj);
          for (jj = 0; jj < parentScopePairs.length; jj++) {
            e = parentScopePairs[jj];
            if (nParentScopes > 1) {
              k = 'parent' + nParentScopes + ':' + e[0];
            } else {
              k = 'parent:' + e[0];
            }
            traceStackEntry.ordered_varnames.push(k);
            assert(!_.has(traceStackEntry.encoded_locals, k));
            traceStackEntry.encoded_locals[k] = encodeObject(e[1]);
          }

          nParentScopes++;
        } else {
          assert(scopeType === 0);
        }
      }

      if (f.isAtReturn()) {
        // constructors implicitly return 'this'
        var retval = isConstructorCall ? receiver : f.returnValue();
        traceStackEntry.ordered_varnames.push('__return__');
        traceStackEntry.encoded_locals.__return__ = encodeToplevelObject(retval);
      }

      // push to front so that the stack grows 'downwards'
      curTraceEntry.stack_to_render.unshift(traceStackEntry);
    }


    // check whether the top frame is currently returning, and if so,
    // update frameIdCalls. it's VERY IMPORTANT to do this update at
    // the very end, or else getCanonicalFrameId() for this iteration
    // will return the wrong number.
    if (topIsReturn) {
      var s = String(topFrame.details_.frameId());
      if (frameIdCalls[s] === undefined) {
        frameIdCalls[s] = 1;
      }
      else {
        frameIdCalls[s] += 1;
      }
    }

    curTrace.push(curTraceEntry);
  }

  // do this at the VERY END of this function, or else weird stuff happens
  if (curTrace.length >= MAX_EXECUTED_LINES) {
    curTrace.push({event: 'instruction_limit_reached',
                   exception_msg: '(stopped after ' + MAX_EXECUTED_LINES + ' steps to prevent possible infinite loop)'});

    finalize();
    // GET OUTTA HERE so that the user's script doesn't keep infinite looping
    process.exit();
  } else {
    assert(stepType !== undefined);
    execState.prepareStep(stepType); // set debugger to stop at next step
  }
}


// for testing
function simpleListener(event, execState, eventData, data) {
  var stepType, i, n;
  var ii, jj, sc, scopeType, scopeObj;
  var f;

  // TODO: catch CompileError and maybe other events too
  if (event !== debug.DebugEvent.Break && event !== debug.DebugEvent.Exception) {
    return;
  }

  var isException = (event === debug.DebugEvent.Exception);

  var script   = eventData.func().script().name();
  var line     = eventData.sourceLine() + 1;
  var col      = eventData.sourceColumn();
  assert(line >= 2);
  line -= 2; // to account for wrapUserscript() adding extra lines

  log(script, line, col, isException);

  // if what we're currently executing isn't inside of userscript.js,
  // then PUNT, since we're probably in the first line of console.log()
  // or some other utility function
  if (script !== 'userscript.js') {
    execState.prepareStep(debug.StepAction.StepOut);
  } else {
    execState.prepareStep(debug.StepAction.StepIn);
  }
}


assert(argv._.length <= 1);
var cod;
if (argv._.length === 1) {
  var FN = argv._[0];
  // trim trailing newlines so that nothing dangles off of the end
  cod = String(fs.readFileSync(FN)).rtrim();
} else {
  assert(argv._.length === 0);
  // take a string from the command line, trimming trailing newlines
  cod = argv.code.rtrim();
}

var wrappedCod = wrapUserscript(cod);

try {
  redirectStdout();
  debug.setListener(listener);
  debug.setBreakOnException(); // for exception handling
  //debug.setBreakOnUncaughtException(); // doesn't seem to do anything :/

  _eval(wrappedCod, 'userscript.js', {} /* scope */, true /* includeGlobals */);
}
catch (e) {
  // for some reason, the node debugger doesn't allow us to keep going
  // after an uncaught exception to, say, execute 'finally' clauses.
  if (curTrace.length > 0) {
    // do a NOP for now ... it's weird to issue an uncaught_exception since
    // that's usually reserved for syntax errors
    /*
    var lastEntry = curTrace[curTrace.length - 1];
    lastEntry.event = 'exception';
    lastEntry.exception_msg = String(e);
    lastEntry.exception_msg += "\n(Uncaught Exception: execution ended due to current limits of\nthis visualizer. 'finally' blocks and other code might not be run.)";
    lastEntry.line = 0;
    */
  } else {
    // likely a compile error since nothing executed yet; trace is empty

    var originalErrorMsg = e.toString();

    var errorTraceEntry = {};
    errorTraceEntry.event = 'uncaught_exception';

    // OK now try to parse the user's original code using esprima, not
    // node's compiler/parser, since esprima gives precise line/column
    // numbers for errors while node doesn't.
    //
    // the main caveat here is that the error messages might be slightly
    // different, and also out of sync, since we're using a different
    // parser. so beware!!!

    var hasEsprimaErr = false;

    try {
      esprima.parse(cod);
    }
    catch (esprimaErr) {
      hasEsprimaErr = true;
      errorTraceEntry.exception_msg = esprimaErr.description;
      errorTraceEntry.line = esprimaErr.lineNumber;
      errorTraceEntry.col = esprimaErr.column;
    }

    if (!hasEsprimaErr) {
      // crap, esprima didn't find a parse error, so just go with
      // originalErrorMsg and throw up our hands since we can't pinpoint
      // the location of the error.
      errorTraceEntry.exception_msg = originalErrorMsg + "\n(sorry, tool can't find the line number)";
    }

    curTrace.push(errorTraceEntry);
  }
}
finally {
  finalize();
}

function finalize() {
  resetStdout(); // so that we can print to stdout again!

  // do some postprocessing to delete the last entry if it's a 'return'
  // and there's nothing on the stack
  if (curTrace.length > 0) {
    var lastEntry = _.last(curTrace);
    if (lastEntry.event === 'return' && _.isEmpty(lastEntry.stack_to_render.length)) {
      curTrace.pop();
    }
  }

  var blob = {code: cod, trace: curTrace};
  if (argv.jsfile) {
    fs.writeFileSync(argv.jsfile, 'var trace = ' + JSON.stringify(blob) + ';\n');
    log('Wrote trace to', argv.jsfile);
  } else if (argv.jsondump) {
    console.log(JSON.stringify(blob));
  } else if (argv.prettydump) {
    console.log(util.inspect(blob, {depth: null}));
  }
}

