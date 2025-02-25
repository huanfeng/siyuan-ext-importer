import { parseFilePath } from '../../filesystem.js';
import { HTMLElementfindAll, parseHTML, createEl, createSpan, generateSiYuanID } from '../../util.js';
import { ZipEntryFile } from '../../zip.js';
import { type MarkdownInfo, type NotionAttachmentInfo, type NotionLink, type NotionProperty, type NotionPropertyType, type NotionResolverInfo } from './notion-types.js';
import {
	escapeHashtags,
	getNotionId,
	hoistChildren,
	stripNotionId,
	stripParentDirectories,
	toTimestamp,
	timestampIsPrueDate,
} from './notion-utils.js';

let lute = window.Lute.New();

function htmlToMarkdown(html: string): string {
    return lute.HTML2Md(html)
}

export async function readToMarkdown(info: NotionResolverInfo, file: ZipEntryFile): Promise<MarkdownInfo> {
	const text = await file.readText();

	const dom = parseHTML(text);
	// read the files etc.
	const body: HTMLElement = dom.querySelector('div[class=page-body]');

	if (body === null) {
		throw new Error('page body was not found');
	}

	cleanInvalidDOM(body);

	// 将所有的 h 标签都用一个 div 包裹起来，防止转换时出现和后续元素粘连到一行的问题
	const headings = body.querySelectorAll('h1, h2, h3, h4, h5, h6');
	headings.forEach(heading => {
		const divNode = document.createElement('div');
		divNode.innerHTML = heading.outerHTML;
		heading.replaceWith(divNode);
	});

	// 由于 database 处理需要靠 <a href> 来构建关联关系，所以需要在转化链接之前完成
	let attributeViews = getDatabases(info, dom);

	// 将页面内所有的 a 标签转换为 siyuan 的双链指向
	const notionLinks = getNotionLinks(info, body);
	convertLinksToSiYuan(info, notionLinks);

	let frontMatter: MarkdownInfo['attrs'] = {};

	const rawProperties = dom.querySelector('table[class=properties] > tbody') as HTMLTableSectionElement | undefined;
	if (rawProperties) {
		const propertyLinks = getNotionLinks(info, rawProperties);
		convertLinksToSiYuan(info, propertyLinks);
		// YAML only takes raw URLS
		convertHtmlLinksToURLs(rawProperties);

		for (let row of Array.from(rawProperties.rows)) {
			const property = parseProperty(row);
			if (property) {
				property.title = property.title.trim().replace(/ /g, '-');
				if (property.title == 'Tags') {
					property.title = 'tags';
				}
				frontMatter[property.title] = property.content;
			}
		}
	}

	replaceNestedTags(body, 'strong');
	replaceNestedTags(body, 'em');
	fixNotionEmbeds(body);
	fixNotionCallouts(body);
	stripLinkFormatting(body);
	fixNotionDates(body);
	fixEquations(body);

	// Some annoying elements Notion throws in as wrappers, which mess up .md
	replaceElementsWithChildren(body, 'div.indented');
	replaceElementsWithChildren(body, 'details');
	fixToggleHeadings(body);
	fixNormalToggle(body);
	fixNotionLists(body, 'ul');
	fixNotionLists(body, 'ol');

	addCheckboxes(body);
	replaceTableOfContents(body);
	formatDatabases(body);

	// 将 dom 中 code 标签的 class 转换为小写
	// 样例 <code class="language-Mermaid"> 转换为 <code class="language-mermaid">

	dom.querySelectorAll('code[class^=language-]').forEach(codeNode => {
		codeNode.className = codeNode.className.toLowerCase();
	});

	let htmlString = body.innerHTML;

	// Simpler to just use the HTML string for this replacement
	splitBrsInFormatting(htmlString, 'strong');
	splitBrsInFormatting(htmlString, 'em');
	

	let markdownBody = htmlToMarkdown(htmlString);
	if (info.singleLineBreaks) {
		// Making sure that any blockquote is preceded by an empty line (otherwise messes up formatting with consecutive blockquotes / callouts)
		markdownBody = markdownBody.replace(/\n\n(?!>)/g, '\n');
	}
	
	markdownBody = escapeHashtags(markdownBody);
	markdownBody = fixDoubleBackslash(markdownBody);

	const description = dom.querySelector('p[class*=page-description]')?.textContent;
	if (description) markdownBody = description + '\n\n' + markdownBody;

	// 替换 markdown 中的 database
	markdownBody = markdownBody.replace(/\[:av:(.*?):\]/g, (_, avID) => {
		return `<div data-type="NodeAttributeView" data-av-id="${avID}" data-av-type="table"></div>`;
	});

	return {
		'content': markdownBody.trim(),
		'attrs': frontMatter,
		'attributeViews': attributeViews,
	}
}

const typesMap: Record<NotionProperty['type'], NotionPropertyType[]> = {
	checkbox: ['checkbox'],
	date: ['created_time', 'last_edited_time', 'date'],
	list: ['file', 'multi_select', 'relation'],
	number: ['number', 'auto_increment_id'],
	text: [
		'email',
		'person',
		'phone_number',
		'text',
		'url',
		'status',
		'select',
		'formula',
		'rollup',
		'last_edited_by',
		'created_by',
	],
};

function parseProperty(property: HTMLTableRowElement): {content: string; title: string;} | undefined {
	const notionType = property.className.match(/property-row-(.*)/)?.[1] as NotionPropertyType;
	if (!notionType) {
		throw new Error('property type not found for: ' + property);
	}

	const title = htmlToMarkdown(property.cells[0].textContent ?? '');

	const body = property.cells[1];

	let type = Object.keys(typesMap).find((type: string) =>
		typesMap[type as NotionProperty['type']].includes(notionType)
	) as NotionProperty['type'];

	if (!type) throw new Error('type not found for: ' + body);

	let content: string = '';

	switch (type) {
		case 'checkbox':
			// checkbox-on: checked, checkbox-off: unchecked.
			content = String(body.innerHTML.includes('checkbox-on'));
			break;
		case 'number':
			const numberContent = Number(body.textContent);
			if (isNaN(numberContent)) return;
			content = String(numberContent);
			break;
		case 'date':
			fixNotionDates(body);
			content = body.querySelector('time')?.textContent || '';
			break;
		case 'list':
			const children = body.children;
			const childList: string[] = [];
			for (let i = 0; i < children.length; i++) {
				const itemContent = children.item(i)?.textContent;
				if (!itemContent) continue;
				childList.push(itemContent);
			}
			content = childList.join('\n');
			if (content.length === 0) return;
			break;
		case 'text':
			content = body.textContent ?? '';
			if (content.length === 0) return;
			break;
	}

	return {
		title,
		content,
	};
}

function isImagePath(p: string): Boolean {
	return /(\.png|\.jpg|\.webp|\.gif|\.bmp|\.jpeg)\!?\S*$/i.test(p);
}

function getDecodedURI(a: HTMLAnchorElement): string {
	return stripParentDirectories(
		decodeURI(a.getAttribute('href') ?? '')
	);
}

/**
 * 从 info.pathsToAttachmentInfo 中找到和路径相符的附件信息
 */
function findAttachment(info: NotionResolverInfo, p: string): NotionAttachmentInfo | undefined {
	for (const filename of Object.keys(info.pathsToAttachmentInfo)) {
		if (filename.includes(p)) {
			return info.pathsToAttachmentInfo[filename]
		}
	}
	return undefined;
}

function getNotionLinks(info: NotionResolverInfo, body: HTMLElement) {
	const links: NotionLink[] = [];

	for (const a of HTMLElementfindAll(body, 'a') as HTMLAnchorElement[]) {
		const decodedURI = getDecodedURI(a);
		const id = getNotionId(decodedURI);

		const attachment = findAttachment(info, decodedURI);
		if (id && decodedURI.endsWith('.html')) {
			links.push({ type: 'relation', a, id });
		}
		else if (attachment) {
			let link_type: NotionLink['type'] = 'attachment';
			if (isImagePath(decodedURI)) {
				link_type = 'image'
			}
			links.push({
				type: link_type,
				a,
				path: attachment.path,
			});
		}
	}

	return links;
}

function fixDoubleBackslash(markdownBody: string) {
	// Persistent error during conversion where backslashes in full-path links written as '\\|' become double-slashes \\| in the markdown.
	// In tables, we have to use \| in internal links. This corrects the erroneous \\| in markdown.

	const slashSearch = /\[\[[^\]]*(\\\\)\|[^\]]*\]\]/;
	const doubleSlashes = markdownBody.match(new RegExp(slashSearch, 'g'));
	doubleSlashes?.forEach((slash) => {
		markdownBody = markdownBody.replace(
			slash,
			slash.replace(/\\\\\|/g, '\u005C|')
		);
	});

	return markdownBody;
}

function fixEquations(body: HTMLElement) {
	for (const ele of HTMLElementfindAll(body, '.katex-html')) {
		ele.remove();
	}
	const mathEls = HTMLElementfindAll(body, 'math');
	for (const mathEl of mathEls) {
		const annotation = mathEl.querySelector('annotation')
		if (!annotation) continue;
		annotation.textContent = annotation.textContent.trim();
		// 如果已经是行级公式，则跳过处理
		if (/\\begin\{.*?\}[\s\S]+\\end\{.*?\}/gmi.test(annotation.textContent)) continue;
		// 单行公式强制改为行级公式
		annotation.textContent = `\\begin{align}\n${annotation.textContent}\n\\end{align}`
		mathEl.replaceWith(annotation)
	}
}

function stripToSentence(paragraph: string) {
	const firstSentence = paragraph.match(/^[^\.\?\!\n]*[\.\?\!]?/)?.[0];
	return firstSentence ?? '';
}

function fixNotionCallouts(body: HTMLElement) {
	for (let callout of HTMLElementfindAll(body, 'figure.callout')) {
		const blockquote = createEl('blockquote');
		const span = createSpan();
		span.textContent = '[!important]';
		blockquote.replaceChildren(...callout.childNodes);
		blockquote.insertBefore(span, blockquote.firstChild);
		callout.replaceWith(blockquote);
	}
}

function fixNotionEmbeds(body: HTMLElement) {
	// Notion embeds are a box with images and description, we simplify for Obsidian.
	for (let embed of HTMLElementfindAll(body, 'a.bookmark.source')) {
		const link = embed.getAttribute('href');
		const title = embed.querySelector('div.bookmark-title')?.textContent;
		const description = stripToSentence(embed.querySelector('div.bookmark-description')?.textContent ?? '');
		let blockquoteEl = createEl('blockquote');
		const infos = [
			'[!bookmark]🔖',
			title,
			description,
		]
		let eles = [];
		for (const info of infos) {
			const divEl = createEl('div');
			divEl.textContent = info.replace(/\n/g, '<br />');
			eles.push(divEl);
		}
		const divEl = createEl('div');
		const linkEl = createEl('a')
		linkEl.setAttribute('href', link);
		linkEl.textContent = link;
		divEl.appendChild(linkEl);
		eles.push(divEl);
		for (const ele of eles) {
			blockquoteEl.appendChild(ele);
		}
		embed.replaceWith(blockquoteEl);
	}
}

function formatDatabases(body: HTMLElement) {
	// Notion includes user SVGs which aren't relevant to Markdown, so change them to pure text.
	for (const user of HTMLElementfindAll(body, 'span[class=user]')) {
		user.innerText = user.textContent ?? '';
	}

	for (const checkbox of HTMLElementfindAll(body, 'td div[class*=checkbox]')) {
		const newCheckbox = createSpan();
		newCheckbox.textContent = checkbox.classList.contains('checkbox-on') ? 'X' : '';
		checkbox.replaceWith(newCheckbox);
	}

	for (const select of HTMLElementfindAll(body, 'table span[class*=selected-value]')) {
		const lastChild = select.parentElement?.lastElementChild;
		if (lastChild === select) continue;
		select.textContent = select.textContent + ', ';
	}

	for (const a of HTMLElementfindAll(body, 'a[href]') as HTMLAnchorElement[]) {
		// Strip URLs which aren't valid, changing them to normal text.
		if (!/^(https?:\/\/|www\.)/.test(a.href)) {
			const strippedURL = createSpan();
			strippedURL.textContent = a.textContent ?? '';
			a.replaceWith(strippedURL);
		}
	}
}

function replaceNestedTags(body: HTMLElement, tag: 'strong' | 'em') {
	for (const el of HTMLElementfindAll(body, tag)) {
		if (!el.parentElement || el.parentElement.tagName === tag.toUpperCase()) {
			continue;
		}
		let firstNested = el.querySelector(tag);
		while (firstNested) {
			hoistChildren(firstNested);
			firstNested = el.querySelector(tag);
		}
	}
}

function splitBrsInFormatting(htmlString: string, tag: 'strong' | 'em') {
	const tags = htmlString.match(new RegExp(`<${tag}>(.|\n)*</${tag}>`));
	if (!tags) return;
	for (let tag of tags.filter((tag) => tag.includes('<br />'))) {
		htmlString = htmlString.replace(
			tag,
			tag.split('<br />').join(`</${tag}><br /><${tag}>`)
		);
	}
}

function replaceTableOfContents(body: HTMLElement) {
	const tocLinks = HTMLElementfindAll(body, 'a[href*=\\#]') as HTMLAnchorElement[];
	for (const link of tocLinks) {
		if (link.getAttribute('href')?.startsWith('#')) {
			link.setAttribute('href', '#' + link.textContent);
		}
	}
}

function stripLinkFormatting(body: HTMLElement) {
	for (const link of HTMLElementfindAll(body, 'link')) {
		link.innerText = link.textContent ?? '';
	}
}

function fixNotionDates(body: HTMLElement) {
	// Notion dates always start with @
	for (const time of HTMLElementfindAll(body, 'time')) {
		time.textContent = time.textContent?.replace(/@/g, '') ?? '';
	}
}

const fontSizeToHeadings: Record<string, 'h1' | 'h2' | 'h3'> = {
	'1.875em': 'h1',
	'1.5em': 'h2',
	'1.25em': 'h3',
};

function fixToggleHeadings(body: HTMLElement) {
	const toggleHeadings = HTMLElementfindAll(body, 'summary');
	for (const heading of toggleHeadings) {
		const style = heading.getAttribute('style');
		if (!style) continue;

		for (const key of Object.keys(fontSizeToHeadings)) {
			if (style.includes(key)) {
				heading.replaceWith(createEl(fontSizeToHeadings[key], { text: heading.textContent ?? '' }));
				break;
			}
		}
	}
}

/// 普通折叠块的处理和标题折叠块差不多, 需要替换为li, 但Notion导出时会在上一级有空的li, 也需要进行删除
function fixNormalToggle(body: HTMLElement) {
	const toggleHeadings = HTMLElementfindAll(body, 'summary');
	for (const heading of toggleHeadings) {
		let style = heading.getAttribute('style');
		if (style) continue;

		const parentLi = heading.closest('li');
		if (parentLi) {
			// 删除上一级的空li
			parentLi.replaceWith(...parentLi.childNodes);
		}
		heading.replaceWith(createEl("li", { text: heading.textContent ?? '' }));
	}
}

function replaceElementsWithChildren(body: HTMLElement, selector: string) {
	let els = HTMLElementfindAll(body, selector);
	for (const el of els) {
		hoistChildren(el);
	}
}

function fixNotionLists(body: HTMLElement, tagName: 'ul' | 'ol') {
	// Notion creates each list item within its own <ol> or <ul>, messing up newlines in the converted Markdown. 
	// Iterate all adjacent <ul>s or <ol>s and replace each string of adjacent lists with a single <ul> or <ol>.
	for (const htmlList of HTMLElementfindAll(body, tagName)) {
		const htmlLists: HTMLElement[] = [];
		const listItems: HTMLElement[] = [];
		let nextAdjacentList: HTMLElement = htmlList;

		while (nextAdjacentList.tagName === tagName.toUpperCase()) {
			htmlLists.push(nextAdjacentList);
			for (let i = 0; i < nextAdjacentList.children.length; i++) {
				listItems.push(nextAdjacentList.children[i] as HTMLElement);
			}
			// classes are always "to-do-list, bulleted-list, or numbered-list"
			if (!nextAdjacentList.nextElementSibling || nextAdjacentList.getAttribute('class') !== nextAdjacentList.nextElementSibling.getAttribute('class')) break;
			nextAdjacentList = nextAdjacentList.nextElementSibling as HTMLElement;
		}

		const joinedList = createEl(tagName);
		for (const li of listItems) {
			joinedList.appendChild(li);
		}

		htmlLists[0].replaceWith(joinedList);
		htmlLists.slice(1).forEach(htmlList => htmlList.remove());
	}
}

function addCheckboxes(body: HTMLElement) {
	for (let checkboxEl of HTMLElementfindAll(body, '.checkbox.checkbox-on')) {
		checkboxEl.replaceWith('[x] ');
	}
	for (let checkboxEl of HTMLElementfindAll(body, '.checkbox.checkbox-off')) {
		checkboxEl.replaceWith('[ ] ');
	}
}

function convertHtmlLinksToURLs(content: HTMLElement) {
	const links = HTMLElementfindAll(content, 'a') as HTMLAnchorElement[];

	if (links.length === 0) return content;
	for (const link of links) {
		const span = createSpan();
		span.textContent = link.getAttribute('href') ?? '';
		link.replaceWith(span);
	}
}

function convertLinksToSiYuan(info: NotionResolverInfo, notionLinks: NotionLink[]) {
	for (let link of notionLinks) {
		let siyuanLink = createSpan();

		switch (link.type) {
			case 'relation':
				const linkInfo = info.idsToFileInfo[link.id];
				if (linkInfo && linkInfo.blockID !== '') {
					siyuanLink.textContent = `((${linkInfo.blockID} '${linkInfo.title}'))`;
				} else {
					console.warn('missing relation data for id: ' + link.id);
					const { basename } = parseFilePath(
						decodeURI(link.a.getAttribute('href') ?? '')
					);
					siyuanLink.textContent = `[[${stripNotionId(basename)}]]`;
				}
				break;
			case 'attachment':
				let attachmentInfo = info.pathsToAttachmentInfo[link.path];
				if (!attachmentInfo) {
					console.warn('missing attachment data for: ' + link.path);
					continue;
				}
				siyuanLink.textContent = `[${attachmentInfo.nameWithExtension}](${attachmentInfo.pathInSiYuanMd})`;
				break;
			case 'image':
				siyuanLink = createEl('img')
				let imageInfo = info.pathsToAttachmentInfo[link.path];
				if (!imageInfo) {
					console.warn('missing image file for: ' + link.path);
					continue;
				}
				siyuanLink.setAttribute('src', imageInfo.pathInSiYuanMd);
				siyuanLink.setAttribute('alt', imageInfo.nameWithExtension);
				break;
		}

		link.a.replaceWith(siyuanLink);
	}
}

// cleanInvalidDOM 清除会导致 siyuan lute 报错的 dom 结构
function cleanInvalidDOM(body: HTMLElement) {
	for (const ele of HTMLElementfindAll(body, 'script[src]')) {
		ele.remove();
	}
    for (const ele of HTMLElementfindAll(body, 'link[rel="stylesheet"]')) {
		ele.remove();
	}
	for (const ele of HTMLElementfindAll(body, 'style')) {
		// 一般在 katex 公式前面会存在 <style>@import url('https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css')</style>
		ele.remove();
	}
}

// generateColumnKey 根据所给的信息生成列
function generateColumnKey(name: string, colType: string, options: any[]) {
	return {
		"id": generateSiYuanID(),
		"name": name,
		"type": colType,
		"icon": "",
		"numberFormat": "",
		"template": "",
		"options": options,
	}
}

// getDatabases 将 notion 中的 database 转化为 siyuan 中的 database
// 并将 dom 中的 database 转为类似于 [:av:20240902133057-ioqa2mz:] 的占位，方便后续处理
function getDatabases(info: NotionResolverInfo, body: HTMLElement) {
	let tableInfos = [];
	// 如果没有 table 则直接返回
	const hasTable = Boolean(body.querySelector('table[class="collection-content"]'));
	if (!hasTable) {
		return []
	}
	// 检查是否为页面内嵌 database
	const isEmbedTable = Boolean(body.querySelector('div[class="collection-content"]'));
	if (isEmbedTable) {
		tableInfos = Array.from(body.querySelectorAll('div[class="collection-content"]')).map((divNode: HTMLElement) => {
			return {
				title: (divNode.querySelector('.collection-title') as HTMLElement)?.innerText.trim() || '',
				tableNode: (divNode.querySelector('table[class="collection-content"]') as HTMLElement),
			}
		})
	} else {
		tableInfos = [{
			title: (body.querySelector('.page-title') as HTMLElement)?.innerText.trim() || '',
			tableNode: (body.querySelector('table[class="collection-content"]') as HTMLElement),
		}]
	}
	let tables = tableInfos.map(tableInfo => {
		let tableNode: HTMLElement = tableInfo.tableNode;
		let cols = Array.from(tableNode.querySelectorAll('thead > tr > th')).map((x: HTMLElement) => {
			return {
				type: x.querySelector('span > svg').classList[0],
				name: x.innerText.trim(),
				selectValues: new Set(),
				values: [],
			}
		})
		let priKeyIndex = 0; // 主键所在的列 index
		for (const colIndex of cols.keys()) {
			if (cols[colIndex].type === 'typesTitle') {
				priKeyIndex = colIndex;
				break
			}
		}
		Array.from(tableNode.querySelectorAll('tbody > tr')).forEach((trNode: HTMLElement) => {
			const rowNotionID = getNotionId(trNode.querySelectorAll('td')[priKeyIndex].querySelector('a').href);
			const rowid = info.idsToFileInfo[rowNotionID]?.blockID || generateSiYuanID();
			const hasRelBlock = Boolean(info.idsToFileInfo[rowNotionID] && info.idsToFileInfo[rowNotionID].blockID !== ''); // 是否有相关联的 block
			Array.from(trNode.querySelectorAll('td')).forEach((tdNode: HTMLElement, colIndex: number) => {
				let baseColValue = {
					rowid: rowid,
					hasRelBlock: hasRelBlock,
				}
				if (cols[colIndex].type === 'typesTitle') {
					cols[colIndex].values.push({
						...baseColValue,
						value: tdNode.querySelector('a').innerText.trim()
					})
				} else if (cols[colIndex].type === 'typesDate') {
					const times = tdNode.innerText.trim().replace('@', '').split('→').map(z => {
						return z.trim();
					}).filter(Boolean)
					cols[colIndex].values.push({
						...baseColValue,
						value: times
					})
				} else if (['typesSelect', 'typesMultipleSelect'].includes(cols[colIndex].type)) {
					let opts = Array.from(tdNode.querySelectorAll('span.selected-value')).map((selectSpan: HTMLElement) => {
						const opt = selectSpan.innerText.trim();
						cols[colIndex].selectValues.add(opt);
						return opt;
					});
					cols[colIndex].values.push({
						...baseColValue,
						value: opts
					})
				} else if (cols[colIndex].type === 'typesCheckbox') {
					cols[colIndex].values.push({
						...baseColValue,
						value: Boolean(tdNode.querySelector('div.checkbox-on'))
					})
				} else if (cols[colIndex].type === 'typesFile') {
					cols[colIndex].values.push({
						...baseColValue,
						value: Array.from(tdNode.querySelectorAll('a')).map(aNode => {
							return getDecodedURI(aNode);
						})
					})
				} else {
					cols[colIndex].values.push({
						...baseColValue,
						value: tdNode.innerText.trim(),
					});
				}
			})
		});
		return {
			title: tableInfo.title,
			cols: cols,
		}
	})
	console.log(tables)
	let avs = tables.map(table => {
		// 构造出所有的数据
		let keyValues = [];
		let rowIds = [];
		for (const col of table.cols) {
			let colType = 'text';
			switch (col.type) {
				case 'typesTitle':
					colType = 'block';
					break;
				case 'typesDate':
					colType = 'date';
					break;
				case 'typesSelect':
					colType = 'select';
					break;
				case 'typesMultipleSelect':
					colType = 'mSelect';
					break;
				case 'typesCheckbox':
					colType = 'checkbox'
					break;
				case 'typesFile':
					colType = 'mAsset';
					break;
			}
			let keyValue = {
				key: {},
				values: []
			}
			if (colType === 'date') {
				keyValue.key = generateColumnKey(`${col.name}`, colType, [])
				keyValue.values = col.values.filter(v => {return Boolean(v.value.length)}).map((x) => {
					// 排除掉空数组，剩余的可构造
					const times = x.value.map(toTimestamp)
					const value = {
						id: generateSiYuanID(),
						keyID: keyValue.key['id'],
						blockID: x.rowid,
						type: colType,
						createdAt: Date.now(),
						updatedAt: Date.now(),
						date: {
							content: times[0],
							isNotEmpty: true,
							hasEndDate: false,
							isNotTime: timestampIsPrueDate(times[0]),
							content2: 0,
							isNotEmpty2: false,
							formattedContent: ""
						}
					}
					if (times.length === 2) {
						value.date.hasEndDate = true;
						value.date.content2 = times[1];
						value.date.isNotEmpty2 = true;
					}
					return value;
				})
			} else if (['select', 'mSelect'].includes(colType)) {
				let opts = new Map()
				for (const [i, x] of Array.from(col.selectValues).entries()) {
					opts.set(x, `${i+1}`)
				}
				keyValue.key = generateColumnKey(`${col.name}`, colType, Array.from(opts, ([name, color]) => ({ name, color })));
				keyValue.values = col.values.filter(v => {return Boolean(v.value.length)}).map((x) => {
					return {
						"id": generateSiYuanID(),
						"keyID": keyValue.key['id'],
						"blockID": x.rowid,
						"type": colType,
						"createdAt": Date.now(),
						"updatedAt": Date.now(),
						"mSelect": x.value.map(v => {
							return {
								content: v,
								color: opts.get(v),
							}
						})
					}
				})
			} else if (colType === 'block') {
				keyValue.key = generateColumnKey(`${col.name}`, colType, [])
				keyValue.values = col.values.map(x => {
					rowIds.push(x.rowid)
					return {
						"id": generateSiYuanID(),
						"keyID": keyValue.key['id'],
						"blockID": x.rowid,
						"type": colType,
						"isDetached": !x.hasRelBlock,
						"createdAt": Date.now(),
						"updatedAt": Date.now(),
						"block": {
							"id": x.rowid,
							"content": x.value,
							"created": Date.now(),
							"updated": Date.now(),
						}
					}
				})
			} else if (colType === 'checkbox') {
				keyValue.key = generateColumnKey(`${col.name}`, colType, [])
				keyValue.values = col.values.filter(v => {return v.value}).map(x => {
					return {
						"id": generateSiYuanID(),
						"keyID": keyValue.key['id'],
						"blockID": x.rowid,
						"type": colType,
						"createdAt": Date.now(),
						"updatedAt": Date.now(),
						"checkbox": {
							"checked": x.value,
						}
					}
				})
			} else if (colType === 'mAsset') {
				keyValue.key = generateColumnKey(`${col.name}`, colType, [])
				keyValue.values = col.values.filter(v => {return Boolean(v.value.length)}).map((x) => {
					return {
						"id": generateSiYuanID(),
						"keyID": keyValue.key['id'],
						"blockID": x.rowid,
						"type": colType,
						"createdAt": Date.now(),
						"updatedAt": Date.now(),
						"mAsset": x.value.map(v => {
							let assetType = 'file'
							if (isImagePath(v)) {
								assetType = 'image'
							}
							let assetPath = v;
							console.log(v);
							console.log(info.pathsToAttachmentInfo);
							const attachment = findAttachment(info, v);
							if (attachment) {
								assetPath = attachment.pathInSiYuanMd
							}
							return {
								type: assetType,
								name: assetPath,
								content: assetPath,
							}
						})
					}
				})
			} else {
				keyValue.key = generateColumnKey(`${col.name}`, 'text', [])
				keyValue.values = col.values.filter(v => {return Boolean(v.value)}).map((x) => {
					return {
						"id": generateSiYuanID(),
						"keyID": keyValue.key['id'],
						"blockID": x.rowid,
						"type": 'text',
						"createdAt": Date.now(),
						"updatedAt": Date.now(),
						"text": {
							"content": x.value,
						}
					}
				})
			}
			keyValues.push(keyValue)
		}
		// 构建成 siyuan 的数据库
		const avID = generateSiYuanID();
		const avViewID = generateSiYuanID();
		const avTableID = generateSiYuanID();
		let avData = {
			"spec": 0,
			"id": avID,
			"name": table.title,
			"keyValues": keyValues,
			"keyIDs": null,
			"viewID": avViewID,
			"views": [
				{
					"id": avViewID,
					"icon": "",
					"name": "表格",
					"hideAttrViewName": false,
					"type": "table",
					"table": {
						"spec": 0,
						"id": avTableID,
						"columns": keyValues.map((x) => {
							return {
								"id": x.key.id,
								"wrap": false,
								"hidden": false,
								"pin": false,
								"width": ""
							}
						}),
						"rowIds": rowIds,
						"filters": [],
						"sorts": [],
						"pageSize": 50
					}
				}
			]
		};
		return avData;
	});
	console.log(avs)
	// 将 dom 中的 database 转为类似于 [:av:20240902133057-ioqa2mz:] 的占位，方便后续处理
	let collectionContentSelector = 'table[class="collection-content"]';
	if (isEmbedTable) {
		collectionContentSelector = 'div[class="collection-content"]'
	}
	body.querySelectorAll(collectionContentSelector).forEach((table, i) => {
		// 创建新的 <div> 元素
		var newDiv = document.createElement('div');
		newDiv.textContent = `[:av:${avs[i].id}:]`;
		
		// 替换掉原来的 <table> 元素
		table.parentNode.replaceChild(newDiv, table);
	});
	return avs;
}