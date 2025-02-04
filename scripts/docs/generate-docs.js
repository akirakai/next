const path = require('path');
const babel = require('babel-core');
const fs = require('fs-extra');
const cheerio = require('cheerio');
const _ = require('lodash');
const glob = require('glob');
const createDocParser = require('@alifd/doc-parser');
const { logger, getComponentName, marked } = require('../utils');
const { getOnlineDemos } = require('./gen-demo-insert-scripts');
const { getGlobalControl } = require('../preview/loaders/index/render-creator');

const SRC_FOLDER = 'docs';
const LANGDOC_FOLDER = 'docs-lang';
const COMPILED_FOLDER = 'compiled_docs';

const cwd = process.cwd();

module.exports = function*() {
    const srcDir = path.join(cwd, SRC_FOLDER);
    const targetDir = path.join(cwd, LANGDOC_FOLDER);
    fs.removeSync(targetDir);
    fs.copySync(srcDir, targetDir);

    try {
        // 编译文档
        yield buildCompiledDocs(cwd);
    } finally {
        fs.remove(targetDir);
    }
};

function* buildDemoMappingList(srcFolder, toFile) {
    const folders = yield fs.readdir(srcFolder);
    let content = 'module.exports = {';

    for (const folder of folders) {
        const folderPath = path.join(srcFolder, folder);
        const folderStat = yield fstat(folderPath);

        // check if the path is folder
        if (folderStat && folderStat.isDirectory()) {
            content += `\n  '${getComponentName(folder)}':  {
    demos: [`;

            const demoFolderPath = path.join(folderPath, 'demo');
            const demoFiles = yield fs.readdir(demoFolderPath);
            for (const demoFile of demoFiles) {
                if (demoFile.endsWith('.md')) {
                    const demoFilePath = `${COMPILED_FOLDER}/${folder}/demo/${demoFile}`;
                    content += `
      '/${demoFilePath}',`;
                }
            }
            content += `
    ],\n
    readme: [`;

            const readmePath = path.join(folderPath);
            const readmeFiles = yield fs.readdir(readmePath);

            for (const readmeFile of readmeFiles) {
                if (readmeFile.endsWith('.md')) {
                    const readmeFilePath = `${COMPILED_FOLDER}/${folder}/${readmeFile}`;
                    content += `
      '/${readmeFilePath}',`;
                }
            }
            content += `
    ],
  },`;
        }
    }
    content += '\n};\n';
    yield fs.writeFile(toFile, content);
}

function* fstat(file) {
    try {
        return yield fs.stat(file);
    } catch (err) {
        logger.warn(err);
        return false;
    }
}

function* buildCompiledDocs(cwd) {
    const from = path.join(cwd, LANGDOC_FOLDER);
    const to = path.join(cwd, COMPILED_FOLDER);
    const componentListPath = path.join(to, 'components.json');
    const demoMappingFilePath = path.join(to, 'mapping.js');
    const docParser = createDocParser({});

    // 1. clear cache
    yield fs.remove(to);

    // 2. compile demos (including /demo, index.md, history.md)
    const ignoreFolders = ['core'];
    const componentList = [];
    const folders = yield fs.readdir(from);
    const globalControls = `
    import { Balloon } from '@alifd/next';
    import { Loading } from '@alifd/next';
    import { Message } from '@alifd/next';
    window.loadingRenderScript = function(loading, showMessage=true){
        try{
            if(loading){
                ReactDOM.render(<Loading visible={true} fullScreen/>, document.getElementById('demo-loading-state'));
                return;
            }
            ReactDOM.unmountComponentAtNode(document.getElementById('demo-loading-state'));
            showMessage && Message.success(window.localStorage.liveDemo === "true" ? "切换到在线编辑模式成功，点击代码区域即可编辑预览。" : "切换到预览模式成功，代码展示为只读模式。");
        }catch(e){
            Message.error(window.localStorage.liveDemo === "true" ? "切换到在线编辑模式失败，请联系管理员。" : "切换到预览模式失败，请联系管理员。")
        }
    }

    window.demoNames = [];
    window.renderFuncs = [];
    ${getGlobalControl()}`;

    for (const folder of folders) {
        const stats = fs.statSync(path.join(from, folder));
        if (!stats.isDirectory() || ignoreFolders.indexOf(folder) > -1) {
            continue;
        }

        const apiFrom = path.join(from, folder, 'index.md');
        const enAPIFrom = path.join(from, folder, 'index.en-us.md');
        const demoBaseFrom = path.join(from, folder, 'demo');

        const apiTo = path.join(to, folder, 'index.md');
        const enAPITo = path.join(to, folder, 'index.en-us.md');
        const demoBaseTo = path.join(to, folder, 'demo');

        yield fs.mkdirp(demoBaseTo);

        // 2.1 compile apiFrom
        const apiFileExists = yield fs.exists(apiFrom);
        if (apiFileExists) {
            const { apiMdParsed, apiMdRendered } = yield compileApiFrom(apiFrom, docParser);

            componentList.push({
                english: apiMdParsed.meta.title,
                chinese: apiMdParsed.meta.chinese,
                family: apiMdParsed.meta.family,
            });

            let apiMdRenderedObj = JSON.parse(apiMdRendered);
            apiMdRenderedObj.renderHtml = transformHTML(globalControls);
            yield fs.writeFile(apiTo, `${JSON.stringify(apiMdRenderedObj)}`, 'utf8');
        } else {
            logger.warn(`${folder} does not has index.md`);
        }

        const enAPIFileExists = yield fs.exists(enAPIFrom);
        if (enAPIFileExists) {
            const { apiMdRendered } = yield compileApiFrom(enAPIFrom, docParser);
            yield fs.writeFile(enAPITo, apiMdRendered, 'utf8');
        } else {
            logger.warn(`${folder} does not has index.en-us.md`);
        }
        // 2.2 compile historyFrom

        // 2.3 compile demos
        const demoFolderStat = yield fstat(demoBaseFrom);
        if (demoFolderStat) {
            const demoFiles = yield fs.readdir(demoBaseFrom);
            for (const demoFile of demoFiles) {
                const name = _.camelCase(demoFile.replace('.md', ''));
                const demoFilePath = path.join(demoBaseFrom, demoFile);
                const demoFileData = yield fs.readFile(demoFilePath, 'utf8');

                const mutliLanguageDocs = mutliLangHandler(demoFileData);

                const cnDoc = mutliLanguageDocs.cn;
                const cnDemoContent = docParser.parse(cnDoc);
                cnDemoContent.name = name;
                cnDemoContent.html = docParser.render(cnDemoContent.body);
                cnDemoContent.renderScript = transformHTML(getOnlineDemos([demoFilePath]));
                const cnDemoContentOutput = JSON.stringify(cnDemoContent);
                const cnDemoFileTo = path.join(demoBaseTo, demoFile);
                yield fs.writeFile(cnDemoFileTo, cnDemoContentOutput, 'utf8');

                if (mutliLanguageDocs.en) {
                    // 把原来带有多语言标识符的文档替换为纯中文文档
                    yield fs.writeFile(demoFilePath, cnDoc, 'utf8');
                    // yield fs.writeFile(path.join(demoLangFrom, demoFile), cnDoc, 'utf8');

                    // 增加一份英文文档
                    const enDoc = mutliLanguageDocs.en;
                    const filename = `${path.basename(demoFile, '.md')}.en-us.md`;
                    const enDemoFilePath = path.join(demoBaseFrom, filename);
                    yield fs.writeFile(enDemoFilePath, enDoc, 'utf8');

                    // 另外再编译一份英文文档
                    const enDemoContent = docParser.parse(enDoc);
                    enDemoContent.name = name;
                    enDemoContent.html = docParser.render(enDemoContent.body);
                    enDemoContent.renderScript = transformHTML(getOnlineDemos([enDemoFilePath]));
                    const enDemoContentOutput = JSON.stringify(enDemoContent);
                    const enDemoFileTo = path.join(demoBaseTo, filename);
                    yield fs.writeFile(enDemoFileTo, enDemoContentOutput, 'utf8');
                }
            }
        } else {
            logger.warn(`${folder} does not has demo folder`);
        }
    }

    // 3. generate component list
    yield fs.writeFile(componentListPath, JSON.stringify(componentList), 'utf8');

    // 4. generate demo mapping list
    yield buildDemoMappingList(to, demoMappingFilePath);
}

function mutliLangHandler(orginData = '') {
    const enDocReg = /:{3}lang(.|\n|\r)*:{3}/g;
    const jsxReg = /`{3,}(.|\n|\r)*`{3,}/g;
    const toDeleteReg = /import\s*('|")([^'"]+?)(?:\1);?\n?/g;

    let enDocs = orginData.match(enDocReg);
    enDocs = enDocs ? enDocs[0] : '';

    // 把 :::lang=xxx去掉
    enDocs = enDocs.replace(/:{3}(lang[=\w-]*)?/g, '');

    let jsxCode = orginData.match(jsxReg);
    jsxCode = jsxCode ? jsxCode[0] : '';
    jsxCode = jsxCode.replace(toDeleteReg, '');

    const cnDocs = orginData.replace(enDocReg, '').replace(jsxReg, '');

    const enVersrionText = enDocs ? `${enDocs}\n\n---\n\n${jsxCode}` : '';
    return {
        cn: cnDocs + jsxCode,
        en: enVersrionText,
    };
}

function* compileApiFrom(apiFrom, docParser) {
    const apiMdFile = yield fs.readFile(apiFrom, 'utf8');
    const apiMdParsed = docParser.parse(apiMdFile);
    // const apiMdRendered = docParser.simpleRender(apiMdParsed.body);
    // TODO 统一所有的mdRender
    const apiMdRendered = marked(apiMdParsed.body);
    const $ = cheerio.load(`<div id="cheerio-load">${apiMdRendered}</div>`);
    $('#API').before('<split></split>');
    const html = $('#cheerio-load').html();
    const [meta, api] = html.split('<split></split>');
    return {
        apiMdParsed,
        apiMdRendered: JSON.stringify({ meta, api }),
    };
}

function transformHTML(code, separate = true) {
    if (separate)
        return `<script>(function(){${
            babel.transform(code, {
                sourceMaps: false,
                babelrc: false,
                presets: [
                    require.resolve('babel-preset-react'),
                    require.resolve('babel-preset-env'),
                    require.resolve('babel-preset-stage-0'),
                ],
            }).code
        }})()</script>`;

    return `<script>${
        babel.transform(code, {
            sourceMaps: false,
            babelrc: false,
            presets: [
                require.resolve('babel-preset-react'),
                require.resolve('babel-preset-env'),
                require.resolve('babel-preset-stage-0'),
            ],
        }).code
    }</script>`;
}
