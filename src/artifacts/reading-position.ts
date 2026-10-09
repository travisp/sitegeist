interface ScrollPosition {
	top: number;
	left: number;
}

function scrollPosition(element: HTMLElement): ScrollPosition {
	return { top: element.scrollTop, left: element.scrollLeft };
}

function restoreScroll(element: HTMLElement, position: ScrollPosition): void {
	element.scrollTop = position.top;
	element.scrollLeft = position.left;
}

/** The pinned Excel renderer puts sheet tabs first, followed by one scroller per sheet. */
function workbookSheets(wrapper: HTMLElement) {
	const tabs = wrapper.querySelectorAll<HTMLButtonElement>(":scope > div:first-child > button");
	return Array.from(tabs, (tab, index) => ({
		name: tab.textContent!,
		tab,
		scroller: wrapper.children[index + 1] as HTMLElement,
	}));
}

/** Preserve existing scrollers and Excel's reading state, whose scrollers are replaced on updates. */
export function captureReadingPosition(viewer: HTMLElement): () => void {
	const scrollers = [viewer, ...viewer.querySelectorAll<HTMLElement>("*")]
		.filter((element) => element.scrollTop !== 0 || element.scrollLeft !== 0)
		.map((element) => ({ element, position: scrollPosition(element) }));
	const workbook = viewer.querySelector<HTMLElement>("#excel-container > div");
	const workbookPosition = workbook ? scrollPosition(workbook) : undefined;
	const sheets = workbook ? workbookSheets(workbook) : [];
	const selectedSheet = sheets.find(({ tab }) => tab.classList.contains("border-primary"))?.name;
	const sheetPositions = new Map(sheets.map(({ name, scroller }) => [name, scrollPosition(scroller)]));

	return () => {
		const updatedWorkbook = viewer.querySelector<HTMLElement>("#excel-container > div");
		if (updatedWorkbook && workbookPosition) {
			const updatedSheets = workbookSheets(updatedWorkbook);
			// Names, not indexes, keep the active sheet stable when the workbook is reordered.
			updatedSheets.find(({ name }) => name === selectedSheet)?.tab.click();
			for (const { name, scroller } of updatedSheets) {
				const position = sheetPositions.get(name);
				if (position) restoreScroll(scroller, position);
			}
			restoreScroll(updatedWorkbook, workbookPosition);
		}
		for (const { element, position } of scrollers) {
			if (element.isConnected) restoreScroll(element, position);
		}
	};
}
