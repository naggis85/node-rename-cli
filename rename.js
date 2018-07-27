const fs = require('fs-extra');
const globby = require("globby");
const namedRegexp = require("named-js-regexp");
const os = require('os');
const path = require('path');
const pathExists = require('path-exists');
const prompt = require('prompt-sync')();
const defaultReplacements = require('./lib/replacements');

let userReplacements;
if (pathExists.sync(os.homedir() + '/.rename/replacements.js')) {
  userReplacements = require(os.homedir() + '/.rename/replacements.js');
} else {
  userReplacements = {};
}
const UNDO_FILE = os.homedir() + '/.rename/undo.json';

const REPLACEMENTS = Object.assign(defaultReplacements, userReplacements);

function wait(ms) {
  var start = new Date().getTime();
  var end = start;
  while(end < start + ms) {
    end = new Date().getTime();
  }
  if(options.verbose) { console.log(''); console.log("Waiting is ready!"); }
}

function getOperations(files, newFileName, options) {
  let operations = [];

  // BUILD FILE INDICIES by file extension
  let fileIndex = buildFileIndex(files, newFileName);
  
  // FOR EACH FILE
  files.forEach(function(value) {
    let uniqueName = (files.length > 1 ? false: true);
    let fullPath = path.resolve(value);
    let fileObj = path.parse(fullPath);
    fileObj.newName = newFileName.name;
    fileObj.newNameExt = (newFileName.ext ? newFileName.ext : fileObj.ext);
    fileObj.index = fileIndex[fileObj.newNameExt].index;
    fileObj.totalFiles = fileIndex[fileObj.newNameExt].total;

    // REGEX match and group replacement
    if (options.regex) {
      fileObj = regexMatch(fileObj, options);
      fileObj = regexGroupReplacement(fileObj, options);
    }
    
    // REPLACEMENT VARIABLES replace the replacement strings with their value
    [fileObj, uniqueName] = replaceVariables(fileObj, uniqueName);

    // APPEND INDEX if output file names are not unique
    if (!uniqueName && !options.noIndex && fileIndex[fileObj.ext].total > 1) {
      fileObj.newName = fileObj.newName + REPLACEMENTS.i.function(fileObj, '1');
    }

    // TRIM output file name unless --notrim option used
    if (!options.noTrim) {
      fileObj.newName = fileObj.newName.trim();
    }

    // ADD to operations
    let outputLocation= path.normalize(newFileName.dir);
    let operationText = fileObj.base + ' → ' + fileObj.newName + fileObj.newNameExt;
    let originalFileName = path.format({dir: fileObj.dir, base: fileObj.base});
    let outputFileName = path.format({dir: outputLocation, base: fileObj.newName + fileObj.newNameExt});
    let conflict = (operations.find(function(o) { return o.output === outputFileName; }) ? true : false);
    let alreadyExists = false;
    if (originalFileName.toLowerCase() !== outputFileName.toLowerCase()) {
      alreadyExists = pathExists.sync(outputFileName);
    }
    
    //wait(3000);
    let _filePath = fileObj.dir+path.sep+fileObj.base;
////    if(options.verbose) { console.log(''); console.log("Result from pathExists: "+JSON.stringify(pathExists(_filePath))); }
//    pathExists(_filePath).then (()=> {
//      if(options.verbose) { console.log(''); console.log(_filePath+" is ready to be processed!"); }
//      operations.push({text: operationText, original: originalFileName, output: outputFileName, conflict: conflict, alreadyExists: alreadyExists});
//    });
    if (path.resolve(_filePath) && pathExists.sync(_filePath)) {
      if(options.verbose) { console.log(''); console.log(_filePath+" is ready to be processed!"); }
      operations.push({text: operationText, original: originalFileName, output: outputFileName, conflict: conflict, alreadyExists: alreadyExists});
    }

    fileIndex[fileObj.newNameExt].index += 1;
  });
  
  return operations;
}

function argvToOptions(argv) {
  return {
    regex: (argv.r ? (Array.isArray(argv.r) ? argv.r : [argv.r]) : false),
    keep: (argv.k ? true : false),
    force: (argv.f ? true : false),
    simulate: (argv.s ? true : false),
    verbose: (argv.v ? true : false),
    noIndex: (argv.n ? true : false),
    noTrim: (argv.notrim ? true : false)
  };
}

function getFileArray(files) {
  if (globby.hasMagic(files)) {
    files = globby.sync(files);
  }
  return files;
}

function hasConflicts(operations) {
  return (operations.find(function(o) { return (o.conflict === true || o.alreadyExists === true); }) ? true : false);
}

function run(operations, options, exitWhenFinished) { // RENAME files
  if (!options) {
    options = {
      regex: false,
      force: false,
      simulate: false,
      verbose: false,
      noIndex: false,
      noTrim: true
    };
  }
  let completedOps = [];
  operations.forEach(function(operation) {
    if (!options.force && operation.original.toLowerCase() !== operation.output.toLowerCase() && pathExists.sync(operation.output)) {
      if (options.keep) {
        operation = keepFiles(operation);
        renameFile(operation.original, operation.output);
        completedOps.push(operation);
      } else {
        console.log('\n' + operation.text + '\n' + operation.text.split(' → ')[1] + ' already exists. What would you like to do?');
        console.log('1) Overwrite the file');
        console.log('2) Keep both files');
        console.log('3) Skip');
        let response = prompt('Please input a number: ');
        if (response === '1') {
          renameFile(operation.original, operation.output);
          completedOps.push(operation);
        } else if (response === '2') {
          operation = keepFiles(operation);
          renameFile(operation.original, operation.output);
          completedOps.push(operation);
        }
      }
    } else {
      renameFile(operation.original, operation.output);
      completedOps.push(operation);
    }
  });

  writeUndoFile(completedOps, (exitWhenFinished === true ? true : false));
}

function getReplacementsList() { // GET LIST OF REPLACEMENT VARIABLES
  let descIndex = 16;
  let returnText = '';
  Object.keys(REPLACEMENTS).forEach(function(key) {
    let value = REPLACEMENTS[key];
    let spaces = (descIndex - key.length - 4 > 0 ? descIndex - key.length - 4 : 1);
    returnText += ' {{' + key + '}}' + ' '.repeat(spaces) + value.name + ': ' + value.description + '\n';
    if (value.parameters) {
      returnText += ' '.repeat(descIndex + 3) + 'Parameters: ' + value.parameters.description + '\n';
    }
  });
  return returnText;
}

function getReplacements() {
  return REPLACEMENTS;
}

function undoRename() { // UNDO PREVIOUS RENAME
  fs.readJSON(UNDO_FILE, (err, packageObj) => {
    if (err) throw err;
    let ops = [];
    packageObj.forEach(function(value) {
      [value.original, value.output] = [value.output, value.original];
      ops.push(value);
    });
    run(ops);
  });
}

function renameFile(oldName, newName) { // rename the file
  try {
    if (pathExists.sync(oldName)) {
      fs.renameSync(oldName, newName);
    } else {
      console.log(oldName + ' does not exist! Operation skipped.');
    }
  } catch (e) {
    throw(e);
  }
}

function writeUndoFile(operations, exitWhenFinished) {
  fs.writeJSON(UNDO_FILE, operations, (err) => {
    if (err) throw err;
    if (exitWhenFinished) process.exit(0);
  });
}

function keepFiles(operation) {
  let appendedInt = 0;
  let newPathObj = path.parse(operation.output);
  let newFilePath;
  let newFileName;
  do {
    appendedInt += 1;
    newFilePath = newPathObj.dir + path.sep + newPathObj.name + '-' + appendedInt + newPathObj.ext;
    newFileName = newPathObj.name + '-' + appendedInt + newPathObj.ext;
  } while (pathExists.sync(newFilePath));
  operation.text = operation.text.split(' → ')[0] + ' → ' + newFileName;
  operation.output = newFilePath;
  return operation;
}

function buildFileIndex(files, newFileName) {
  let fileIndex = {};
  if (newFileName.ext) {
    fileIndex[newFileName.ext] = {
      index: 1,
      total: files.length
    };
  } else {
    files.forEach(function(value) {
      let fileObj = path.parse(path.resolve(value));
      if (fileIndex[fileObj.ext]) {
        fileIndex[fileObj.ext].total += 1;
      } else {
        fileIndex[fileObj.ext] = {
          index: 1,
          total: 1
        };
      }
    });
  }
  return fileIndex;
}

function regexMatch(fileObj, options) {
  let pattern;
  let patterns = [];
  let matches = [];
  options.regex.forEach((regex) => {
    try {
      pattern = new RegExp(regex.replace(/\(\?\<\w+\>/g, '('), 'g');
    } catch (err) {
      console.log(err.message);
      process.exit(1);
    }
    matches = matches.concat(fileObj.name.match(pattern));
    patterns.push(pattern);
  });
  fileObj.regexPatterns = patterns;
  fileObj.regexMatches = matches;

  return fileObj;
}

function regexGroupReplacement(fileObj, options) {
  options.regex.forEach((regex) => {
    let groupNames = regex.match(/\<[A-Za-z]+\>/g);
    if (groupNames !== null) {
      let re = namedRegexp(regex);
      let reGroups = re.execGroups(fileObj.name);
      groupNames.forEach(function(value) {
        let g = value.replace(/\W/g, '');
        if (reGroups && reGroups[g]) {
          fileObj.newName = fileObj.newName.replace('{{' + g + '}}', reGroups[g]);
        } else {
          fileObj.newName = fileObj.newName.replace('{{' + g + '}}', '');
        }
      });
    }
  });

  return fileObj;
}

function replaceVariables(fileObj, uniqueName) {
  let repSearch = /\{{2}([\w]+?)\}{2}|\{{2}([\w]+?)\|(.*?)\}{2}/;
  let repResult = repSearch.exec(fileObj.newName);
  while (repResult !== null) {
    let repVar = repResult[1] || repResult[2];
    if (Object.keys(REPLACEMENTS).indexOf(repVar) > -1) {
      let repObj = REPLACEMENTS[repVar];
      let defaultArg = (repObj.parameters && repObj.parameters.default ? repObj.parameters.default : '');
      let repArg = (repResult[3] ? repResult[3] : defaultArg);
      fileObj.newName = fileObj.newName.replace(repResult[0], repObj.function(fileObj, repArg));
      if (repObj.unique) {
        uniqueName = true;
      }
    } else {
      throw 'InvalidReplacementVariable';
    }
    repResult = repSearch.exec(fileObj.newName);
  }

  return [fileObj, uniqueName];
}

module.exports = {
  getOperations: getOperations,
  argvToOptions: argvToOptions,
  run: run,
  getFileArray: getFileArray,
  hasConflicts: hasConflicts,
  getReplacementsList: getReplacementsList,
  getReplacements: getReplacements,
  undoRename: undoRename
};
