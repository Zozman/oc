'use strict';

var async = require('async');
var CleanCss = require('clean-css');
var format = require('stringformat');
var fs = require('fs-extra');
var handlebars = require('handlebars');
var hashBuilder = require('../../utils/hash-builder');
var jade = require('jade');
var nodeDir = require('node-dir');
var request = require('../../utils/request');
var path = require('path');
var settings = require('../../resources/settings');
var Targz = require('tar.gz');
var uglifyJs = require('uglify-js');
var validator = require('../../registry/domain/validator');
var vm = require('vm');
var _ = require('underscore');

module.exports = function(){

  var targz = new Targz();

  var javaScriptizeTemplate = function(functionName, data){
    return format('var {0}={0}||{};{0}.components={0}.components||{};{0}.components[\'{1}\']={2}', 'oc', functionName, data.toString());
  };

  var compileView = function(template, type){
    var preCompiledView;

    if(type === 'jade'){
      preCompiledView = jade.compileClient(template, {
        compileDebug: false,
        name: 't'
      }).toString().replace('function t(locals) {', 'function(locals){');
    } else if(type === 'handlebars'){
      preCompiledView = handlebars.precompile(template);
    } else {
      throw 'template type not supported';
    }

    var hashView = hashBuilder.fromString(preCompiledView.toString()),
        compiledView = javaScriptizeTemplate(hashView, preCompiledView);

    return { 
      hash: hashView, 
      view: uglifyJs.minify(compiledView, {fromString: true}).code 
    };
  };        

  var getLocalDependencies = function(componentPath, serverContent){

    var localRequires = [],
        wrappedRequires = {};
    
    var requireRecorder = function(name){
      if(!_.contains(localRequires, name)){
        localRequires.push(name);
      }
    };

    var context = { 
      require: requireRecorder, 
      module: { exports: {} },
      console: { log: _.noop }
    };

    vm.runInNewContext(serverContent, context);

    var tryEncapsulating = function(requireAlias, filePath){
      if(!wrappedRequires[requireAlias]){
        if(fs.existsSync(filePath)){
          var content = fs.readFileSync(filePath).toString();
          wrappedRequires[requireAlias] = JSON.parse(content);
        } else {
          throw filePath + ' not found. Only json files are require-able.';
        }
      }
    };

    _.forEach(localRequires, function(required){
      if(_.first(required) === '/' || _.first(required) === '.'){
        var requiredPath = path.resolve(componentPath, required),
            ext = path.extname(requiredPath).toLowerCase();

        if(ext === '.json'){
          tryEncapsulating(required, requiredPath);
        } else if(ext === ''){
          tryEncapsulating(required, requiredPath + '.json');
        } else {
          throw 'Requiring local js files is not allowed. Keep it small.';
        }
      }
    });

    return wrappedRequires;
  };

  var getSandBoxedJs = function(wrappedRequires, serverContent){
    if(_.keys(wrappedRequires).length > 0){
      serverContent = 'var __sandboxedRequire = require, __localRequires=' + JSON.stringify(wrappedRequires) +
                      ';require=function(x){return __localRequires[x] ? __localRequires[x] : __sandboxedRequire(x); };\n' +
                      serverContent;
    }

    return uglifyJs.minify(serverContent, {fromString: true}).code;
  };

  return _.extend(this, {
    cleanup: function(compressedPackagePath, callback){
      return fs.unlink(compressedPackagePath, callback);
    },
    compress: function(input, output, callback){
      return targz.compress(input, output, callback);
    },
    getComponentsByDir: function(componentsDir, callback){

      try {
        var components = fs.readdirSync(componentsDir).filter(function(file){

          var filePath = path.resolve(componentsDir, file),
            isDir = fs.lstatSync(filePath).isDirectory();

          return isDir ? (fs.readdirSync(filePath).filter(function(file){
            return file === 'package.json';
          }).length === 1) : false;
        });

        var fullPathComponents = _.map(components, function(component){
          return path.resolve(componentsDir, component);
        });

        callback(null, fullPathComponents);

      } catch(err){
        return callback(err);
      }
    },
    getLocalNpmModules: function(componentsDir){

      var nodeFolder = path.join(componentsDir, 'node_modules');

      if(!fs.existsSync(nodeFolder)){
        return [];
      }

      return fs.readdirSync(nodeFolder).filter(function(file){

        var filePath = path.resolve(nodeFolder, file),
            isBin = file === '.bin',
            isDir = fs.lstatSync(filePath).isDirectory();

        return isDir && !isBin;
      });
    },
    info: function(callback){
      return fs.readJson(settings.configFile.src, callback);
    },
    init: function(componentName, templateType, callback){

      if(!validator.validateComponentName(componentName)){
        return callback('name not valid');
      }

      if(!validator.validateTemplateType(templateType)){
        return callback('template type not valid');
      }

      try {

        var pathDir = '../../components/base-component-' + templateType,
            baseComponentDir = path.resolve(__dirname, pathDir),
            npmIgnorePath = path.resolve(__dirname, pathDir + '/.npmignore');

        fs.ensureDirSync(componentName);
        fs.copySync(baseComponentDir, componentName);
        fs.copySync(npmIgnorePath, componentName + '/.gitignore');

        var componentPath = path.resolve(componentName, 'package.json'),
          component = _.extend(fs.readJsonSync(componentPath), {
            name: componentName
          });

        fs.outputJsonSync(componentPath, component);

        return callback(null, { ok: true });
      } catch(e){
        return callback(e);
      }
    },
    link: function(componentName, componentVersion, callback){

      var localConfig = fs.readJsonSync(settings.configFile.src);

      if(!localConfig || !localConfig.registries || localConfig.registries.length === 0){
        return callback('Registry configuration not found. Add a registry reference to the project first');
      }

      localConfig.components = localConfig.components || {};

      if(!!localConfig.components[componentName]){
        return callback('Component already linked in the project');
      }

      var componentHref = format('{0}/{1}/{2}', localConfig.registries[0], componentName, componentVersion);

      request(componentHref, function(err, res){
        if(err || !res){
          return callback('Component not available');
        }

        try {
          var apiResponse = JSON.parse(res);
          if(apiResponse.type !== 'oc-component'){
            return callback('not a valid oc Component');
          }
        } catch(e){
          return callback('not a valid oc Component');
        }

        localConfig.components[componentName] = componentVersion;
        fs.writeJson(settings.configFile.src, localConfig, callback);
      });
    },
    package: function(componentPath, minify, callback){

      if(_.isFunction(minify)){
        callback = minify;
        minify = true;
      }

      var files = fs.readdirSync(componentPath),
          publishPath = path.join(componentPath, '_package');

      if(_.contains(files, '_package')){
        fs.removeSync(publishPath);
      }

      fs.mkdirSync(publishPath);

      var componentPackagePath = path.join(componentPath, 'package.json'),
          ocPackagePath = path.join(__dirname, '../../package.json');

      if(!fs.existsSync(componentPackagePath)){
        return callback('component does not contain package.json');
      } else if(!fs.existsSync(ocPackagePath)){
        return callback('error resolving oc internal dependencies');
      }

      var component = fs.readJsonSync(componentPackagePath),
          viewPath = path.join(componentPath, component.oc.files.template.src);

      if(!fs.existsSync(viewPath)){
        return callback(format('file {0} not found', component.oc.files.template.src));
      } else if(!validator.validateComponentName(component.name)){
        return callback('name not valid');
      }

      var ocInfo = fs.readJsonSync(ocPackagePath),
          template = fs.readFileSync(viewPath).toString(),
          compiled;

      try {
        compiled = compileView(template, component.oc.files.template.type);
      } catch(e){
        return callback(e);
      }

      fs.writeFileSync(path.join(publishPath, 'template.js'), compiled.view);

      component.oc.files.template = {
        type: component.oc.files.template.type,
        hashKey: compiled.hash,
        src: 'template.js'
      };

      delete component.oc.files.client;
      component.oc.version = ocInfo.version;

      if(!!component.oc.files.data){
        var dataPath = path.join(componentPath, component.oc.files.data),
            serverContent = fs.readFileSync(dataPath).toString(),
            wrappedRequires;

        try {
          wrappedRequires = getLocalDependencies(componentPath, serverContent);
        } catch(e){ 
          if(e instanceof SyntaxError){
            return callback('Error while parsing json');
          }
          return callback(e);
        }

        var sandBoxedJs = getSandBoxedJs(wrappedRequires, serverContent);
        fs.writeFileSync(path.join(publishPath, 'server.js'), sandBoxedJs);

        component.oc.files.dataProvider = {
          type: 'node.js',
          haskey: hashBuilder.fromString(sandBoxedJs),
          src: 'server.js'
        };

        delete component.oc.files.data;
      }

      if(!component.oc.files.static){
        component.oc.files.static = [];
      }

      if(!_.isArray(component.oc.files.static)){
        component.oc.files.static = [component.oc.files.static];
      }

      fs.writeJsonSync(path.join(publishPath, 'package.json'), component);

      var copyDir = function(staticComponent, staticPath, cb){
        if(!fs.existsSync(staticPath)){
          return cb('"' + staticPath + '" not found');
        } else if(!fs.lstatSync(staticPath).isDirectory()){
          return cb('"' + staticPath + '" must be a directory');
        } else {
          nodeDir.paths(staticPath, function(err, res){
            fs.ensureDirSync(path.join(publishPath, staticComponent));
            _.forEach(res.files, function(filePath){
              var fileName = path.basename(filePath),
                  fileExt = path.extname(filePath),
                  fileDestination = path.join(publishPath, staticComponent, fileName),
                  fileContent, 
                  minifiedContent;

              if(minify && fileExt === '.js' && component.oc.minify !== false){
                fileContent = fs.readFileSync(filePath).toString();
                minifiedContent = uglifyJs.minify(fileContent, {fromString: true}).code;

                fs.writeFileSync(fileDestination, minifiedContent);
              } else if(minify && fileExt === '.css' && component.oc.minify !== false){
                fileContent = fs.readFileSync(filePath).toString(),
                minifiedContent = new CleanCss().minify(fileContent).styles;

                fs.writeFileSync(fileDestination, minifiedContent);
              } else {
                fs.copySync(filePath, fileDestination);
              }
            });
            cb(null, 'ok');
          });
        }
      };

      if(component.oc.files.static.length === 0){
        return callback(null, component);
      }
      async.eachSeries(component.oc.files.static, function(staticDir, cb){
        copyDir(staticDir, path.join(componentPath, staticDir), cb);
      }, function(errors){
        if(errors){
          return callback(errors);
        }

        callback(null, component);
      });
    },
    unlink: function(componentName, callback){
      var localConfig = fs.readJsonSync(settings.configFile.src) || {};

      if(!!localConfig.components[componentName]){
        delete localConfig.components[componentName];
      }

      fs.writeJson(settings.configFile.src, localConfig, callback);
    }
  });
};