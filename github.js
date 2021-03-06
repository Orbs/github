var exec = require('child_process').exec;
var fs = require('fs');
var path = require('path');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var request = require('request');

var Promise = require('rsvp').Promise;
var asp = require('rsvp').denodeify;

var tar = require('tar');
var zlib = require('zlib');

var execOpt;

var username, password;
var remoteString;
var apiRemoteString;

var GithubLocation = function(options) {
  username = options.username;
  password = options.password;
  execOpt = {
    cwd: options.tmpDir,
    timeout: options.timeout * 1000,
    killSignal: 'SIGKILL'
  };

  this.remote = options.remote;

  remoteString = 'https://' + (username ? (username + ':' + password + '@') : '') + 'github.com/';
  apiRemoteString = 'https://' + (username ? (username + ':' + password + '@') : '') + 'api.github.com/';
}

function clearDir(dir) {
  return asp(fs.exists)(dir)
  .then(function(exists) {
    if (exists)
      return asp(rimraf)(dir);
  });
}

function prepDir(dir) {
  return clearDir(dir)
  .then(function() {
    return asp(mkdirp)(dir);
  });
}

function checkReleases(repo, version) {

  return asp(request)({
    uri: apiRemoteString + 'repos' + repo + '/releases',
    headers: {
      'User-Agent': 'jspm'
    },
    strictSSL: false,
    followRedirect: false
  })
  .then(function(res) {
    try {
      return JSON.parse(res.body);
    }
    catch(e) {
      throw 'Unable to parse GitHub API response';
    }
  })
  .then(function(releases) {
    // run through releases list to see if we have this version tag
    for (var i = 0; i < releases.length; i++) {
      var tagName = releases[i].tag_name.trim();

      if (tagName == version) {
        var firstAsset = releases[i].assets[0];
        if (!firstAsset)
          return false;

        var assetType;

        if (firstAsset.name.substr(firstAsset.name.length - 7, 7) == '.tar.gz' || firstAsset.name.substr(firstAsset.name.length - 4, 4) == '.tgz')
          assetType = 'tar';
        else if (firstAsset.name.substr(firstAsset.name.length - 4, 4) == '.zip')
          assetType = 'zip';
        else
          return false;

        return { url: firstAsset.url, type: assetType };
      }
    }
    return false;
  });
}


// check if the given directory contains one directory only
// so that when we unzip, we should use the inner directory as
// the directory
function checkStripDir(dir) {
  return asp(fs.readdir)(dir)
  .then(function(files) {
    if (files.length > 1)
      return dir;

    var dirPath = path.resolve(dir, files[0]);

    return asp(fs.stat)(dirPath);
  })
  .then(function(stat) {
    if (stat.isDirectory())
      return dirPath;
    
    return dir;
  });
}


GithubLocation.prototype = {

  parse: function(name) {
    var parts = name.split('/');
    var packageName = parts.splice(0, 2).join('/');
    return {
      package: packageName,
      path: parts.join('/')
    };
  },

  configure: function(config) {
    config.name = 'github';
    config.remote = 'https://github.jspm.io';
    return Promise.resolve(config);
  },

  // return values
  // { versions: { versionhash } }
  // { redirect: 'newrepo' }
  // { notfound: true }
  lookup: function(repo) {
    return new Promise(function(resolve, reject) {

      var versions, cancel, passed = 0;

      // request the repo to check that it isn't a redirect
      request({
        uri: apiRemoteString + 'repos/' + repo,
        headers: {
          'User-Agent': 'jspm'
        },
        strictSSL: false,
        followRedirect: false
      })
      .on('response', function(res) {
        if (cancel)
          return;

        // redirect
        if (res.statusCode == 301) {
          cancel = true;
          return resolve({ redirect: res.headers.location.split('/').splice(3) });
        }
        //not found
        if (res.statusCode == 404) {
          cancel = true;
          return resolve({ notfound: true });
        }
        //other error
        else if (res.statusCode != 200) {
          cancel = true;
          return reject('Invalid status code ' + res.statusCode);
        }
        
        passed++;
        if (passed == 2)
          return resolve({ versions: versions });
      })
      .on('error', function(err) {
        cancel = true;
        reject(err);
      });

      exec('git ls-remote ' + remoteString + repo + '.git refs/tags/* refs/heads/*', execOpt, function(err, stdout, stderr) {
        if (cancel)
          return;

        if (err) {
          if ((err + '').indexOf('Repository not found') == -1) {
            cancel = true;
            reject(stderr);
          }
          return;
        }

        versions = {};
        var refs = stdout.split('\n');
        for (var i = 0; i < refs.length; i++) {
          if (!refs[i])
            continue;
          
          var hash = refs[i].substr(0, refs[i].indexOf('\t'));
          var refName = refs[i].substr(hash.length + 1);

          if (refName.substr(0, 11) == 'refs/heads/')
            versions[refName.substr(11)] = hash;
          else if (refName.substr(0, 10) == 'refs/tags/') {
            if (refName.substr(refName.length - 3, 3) == '^{}')
              versions[refName.substr(10, refName.length - 13)] = hash;
            else
              versions[refName.substr(10)] = hash;
          }
        }

        passed++;
        if (passed == 2)
          resolve({ versions: versions });
      });

    });
  },

  // optional hook, allows for quicker dependency resolution
  // since download doesn't block dependencies
  getPackageConfig: function(repo, version, hash) {
    // NB ensure this works for private repos
    var reqOptions = {
      uri: 'https://raw.githubusercontent.com/' + repo + '/' + hash + '/package.json',
      strictSSL: false
    };
    if (username)
      reqOptions.auth = {
        user: username,
        pass: password
      };
    
    return asp(request)(reqOptions).then(function(res) {
      if (res.statusCode == 404) {
        // it is quite valid for a repo not to have a package.json
        return {};
      }
      if (res.statusCode != 200)
        throw 'Unable to check repo package.json for release';
      
      var packageJSON;

      try {
        packageJSON = JSON.parse(res.body);
      }
      catch(e) {
        throw 'Error parsing package.json';
      }

      return packageJSON;
    });
  },

  // always an exact version
  // assumed that this is run after getVersions so the repo exists
  download: function(repo, version, hash, outDir) {
    
    return checkReleases(repo, version)
    .then(function(release) {
      if (!release)
        return true;

      // Download from the release archive
      return new Promise(function(resolve, reject) {

        var inPipe;

        if (release.type == 'tar') {
          inPipe = zlib.createGunzip()
          .pipe(tar.Extract({ path: outDir, strip: 1 }))
          .on('end', function() {
            resolve();
          })
          .on('error', reject);
        }
        else if (release.type == 'zip') {
          var tmpDir = path.resolve(execOpt.cwd, 'release-' + repo.replace('/', '#') + '-' + version);
          var tmpFile = tmpDir + '.' + type;
          if (process.platform.match(/^win/))
            return errback('No unzip support for windows yet due to https://github.com/nearinfinity/node-unzip/issues/33. Please post a jspm-cli issue.');
          
          inPipe = fs.createWriteStream(tmpFile)
          .on('finish', function() {
            Promise.resolve()
            .then(function() {
              return asp(exec)('unzip -o ' + tmpFile + ' -d ' + tmpDir + ' && chmod -R +w ' + tmpDir, execOpt)
            })
            .then(function() {
              return checkStripDir(tmpDir);
            })
            .then(function(repoDir) {
              return prepDir(outDir);
            })
            .then(function() {
              return asp(fs.rename)(repoDir, outDir);
            })
            .then(function() {
              if (repoDir != tmpDir)
                return asp(fs.rmdir)(tmpDir);
            })
            .then(function() {
              return asp(fs.unlink)(tmpFile);
            })
            .then(resolve, reject);
          })
          .on('error', reject);
        }
        else {
          throw 'Github release found, but no archive present.';
        }

        // now that the inPipe is ready, do the request
        request({
          uri: archiveURL, 
          headers: { 
            'accept': 'application/octet-stream', 
            'user-agent': 'jspm'
          },
          strictSSL: false
        }).on('response', function(archiveRes) {
          if (archiveRes.statusCode != 200)
            return reject('Bad response code ' + archiveRes.statusCode + '\n' + JSON.sringify(archiveRes.headers));
          
          if (archiveRes.headers['content-length'] > 100000000)
            return reject('Response too large.');

          archiveRes.pause();

          archiveRes.pipe(inPipe);

          archiveRes.on('error', reject);

          archiveRes.resume();
        })
        .on('error', reject);
      });
    })
    .then(function(git) {
      if (!git)
        return;

      // Download from the git archive
      return new Promise(function(resolve, reject) {
        request({
          uri: remoteString + repo + '/archive/' + version + '.tar.gz',
          headers: { 'accept': 'application/octet-stream' },
          strictSSL: false
        })
        .on('response', function(pkgRes) {

          if (pkgRes.statusCode != 200)
            return reject('Bad response code ' + pkgRes.statusCode);
          
          if (pkgRes.headers['content-length'] > 10000000)
            return reject('Response too large.');

          pkgRes.pause();

          var gzip = zlib.createGunzip();

          pkgRes
          .pipe(gzip)
          .pipe(tar.Extract({ path: outDir, strip: 1 }))
          .on('error', reject)
          .on('end', resolve);

          pkgRes.resume();

        })
        .on('error', reject);
      });
    });
  }
};

module.exports = GithubLocation;
