import { ArtifactElement, AttachmentOverlay, loadAttachment } from "@earendil-works/pi-web-ui";
import { Diff } from "@mariozechner/mini-lit/dist/Diff.js";
import { iconDOM } from "@mariozechner/mini-lit/dist/icons.js";
import { MarkdownBlock } from "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import JSZip from "jszip";
import { render } from "lit";
import { Bug, FileText, SearchCode } from "lucide";
import { utils, write } from "xlsx";
import { OrbAnimation } from "../components/OrbAnimation.js";
import { assert, type BrowserTest, equal } from "./test-utils.js";

// A small, valid PDF with an explicit xref table; no external fixtures or network are needed.
function pdfFixture(): ArrayBuffer {
	const content = "BT /F1 18 Tf 30 100 Td (PDF fixture text) Tj ET";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(pdf.length);
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xrefOffset = pdf.length;
	pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
	return new TextEncoder().encode(pdf).buffer;
}

async function docxFixture(): Promise<ArrayBuffer> {
	const zip = new JSZip();
	zip.file(
		"[Content_Types].xml",
		`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
	);
	zip.file(
		"_rels/.rels",
		`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
	);
	zip.file(
		"word/document.xml",
		`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX fixture text</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
	);
	return zip.generateAsync({ type: "arraybuffer" });
}

async function animationFrames(count: number) {
	for (let index = 0; index < count; index++) await new Promise(requestAnimationFrame);
}

async function waitForContent(element: Element, selector: string) {
	const deadline = performance.now() + 5000;
	while (!element.querySelector(selector)) {
		assert(performance.now() < deadline, `Timed out waiting for ${selector}: ${element.textContent}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	await animationFrames(2);
}

function assertCanvas(canvas: HTMLCanvasElement | null) {
	assert(canvas && canvas.width > 0 && canvas.height > 0, "sized animation canvas");
	const gl = canvas.getContext("webgl2");
	assert(gl && !gl.isContextLost(), "live WebGL context");
	equal(gl.getError(), gl.NO_ERROR, "no WebGL rendering errors");
}

export const renderingTests: BrowserTest[] = [
	{
		name: "PDF attachment extraction and preview use the matching PDF.js worker",
		async run() {
			const attachment = await loadAttachment(pdfFixture(), "fixture.pdf");
			assert(attachment.extractedText?.includes("PDF fixture text"), "PDF text extracted");
			assert(attachment.preview?.startsWith("iVBOR"), "PDF PNG preview rendered");
			AttachmentOverlay.open(attachment);
			const overlay = document.querySelector("attachment-overlay");
			assert(overlay instanceof AttachmentOverlay, "PDF overlay opened");
			try {
				await waitForContent(overlay, "canvas");
				assert(!overlay.textContent?.includes("Error"), "PDF overlay rendered without errors");
			} finally {
				window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
			}
			const artifact = document.createElement("pdf-artifact");
			assert(artifact instanceof ArtifactElement, "PDF artifact registered");
			artifact.filename = "fixture.pdf";
			artifact.content = attachment.content;
			document.body.append(artifact);
			try {
				await waitForContent(artifact, "canvas");
				assert(!artifact.textContent?.includes("Error"), "PDF artifact rendered without errors");
			} finally {
				artifact.remove();
			}
		},
	},
	{
		name: "DOCX and XLSX attachments extract through the pinned web UI",
		async run() {
			const document = await loadAttachment(await docxFixture(), "fixture.docx");
			assert(document.extractedText?.includes("DOCX fixture text"), "DOCX text extracted");
			AttachmentOverlay.open(document);
			const overlay = globalThis.document.querySelector("attachment-overlay");
			assert(overlay instanceof AttachmentOverlay, "DOCX overlay opened");
			try {
				await waitForContent(overlay, "section.docx");
				assert(
					overlay.querySelector("section.docx")?.textContent?.includes("DOCX fixture text"),
					"DOCX preview rendered",
				);
			} finally {
				window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
			}
			const workbook = utils.book_new();
			utils.book_append_sheet(
				workbook,
				utils.aoa_to_sheet([
					["Name", "Count"],
					["Example", 42],
				]),
				"Sheet1",
			);
			const sheet = await loadAttachment(
				write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
				"fixture.xlsx",
			);
			assert(sheet.extractedText?.includes("Example") && sheet.extractedText.includes("42"), "XLSX cells extracted");
		},
	},
	{
		name: "Markdown renders links, tables, code, escaped HTML, and inline/display math",
		async run() {
			const markdown = new MarkdownBlock();
			markdown.content =
				"# Heading\n\n[Example](https://example.test)\n\n| Name | Count |\n| --- | --- |\n| Test | 42 |\n\nInline $x^2$.\n\n$$x^2 + y^2$$\n\n```javascript\nconst x = 42;\n```\n\n<div>Literal HTML</div>";
			document.body.append(markdown);
			try {
				await markdown.updateComplete;
				equal(markdown.querySelector("h1")?.textContent, "Heading", "heading");
				equal(markdown.querySelector("a")?.target, "_blank", "external link target");
				assert(markdown.querySelector("a")?.rel.includes("noopener"), "safe link relation");
				assert(markdown.querySelector("table")?.textContent?.includes("42"), "table rendered");
				assert(markdown.querySelector('code-block[language="javascript"]'), "code component rendered");
				equal(markdown.querySelectorAll(".katex").length, 2, "inline and display math rendered");
				assert(markdown.querySelector(".katex-display"), "display math rendered");
				assert(markdown.textContent?.includes("<div>Literal HTML</div>"), "HTML remains escaped");
			} finally {
				markdown.remove();
			}
		},
	},
	{
		name: "mini-lit diff rendering and Lucide icons work with the updated libraries",
		async run() {
			const host = document.createElement("div");
			document.body.append(host);
			try {
				render(Diff({ oldText: "same\nold\n", newText: "same\nnew\n", title: "Changes" }), host);
				const text = host.textContent ?? "";
				assert(text.includes("+ new") && text.includes("- old"), "diff includes additions and deletions");
				for (const icon of [Bug, FileText, SearchCode]) {
					const svg = iconDOM(icon, "sm");
					assert(svg.tagName.toLowerCase() === "svg" && svg.children.length > 0, "SVG icon created");
					assert(svg.classList.contains("w-4"), "icon size retained");
				}
			} finally {
				host.remove();
			}
		},
	},
	{
		name: "extension Three.js orb renders in WebGL",
		async run() {
			const style = document.createElement("style");
			style.textContent = ".orb-container { width: 160px; height: 160px; }";
			const orb = new OrbAnimation();
			document.body.append(style, orb);
			try {
				await orb.updateComplete;
				await animationFrames(3);
				assertCanvas(orb.querySelector("canvas"));
			} finally {
				orb.remove();
				style.remove();
			}
		},
	},
	{
		name: "website Three.js orb renders in WebGL",
		async run() {
			// The website registers the same element name, so test its bundle in another document.
			const frame = document.createElement("iframe");
			frame.src = "/site-orb.html";
			const loaded = new Promise<void>((resolve) => {
				frame.onload = () => resolve();
			});
			document.body.append(frame);
			try {
				await loaded;
				await animationFrames(5);
				assertCanvas(frame.contentDocument?.querySelector("canvas") ?? null);
			} finally {
				frame.remove();
			}
		},
	},
];
