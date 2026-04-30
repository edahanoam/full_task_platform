const DATASET_PATH = "./UFOGenZ.jsonl";
const DATASET_CACHE_BUSTER = "ufo-genz-20260428";
const ANNOTATION_SAVE_PATH = "/api/annotations/save";
const LOCAL_SESSION_KEY = "annotation_task_session_id";
const SAVE_DEBOUNCE_MS = 700;

let articles = [];
let saveDebounceTimer = null;

const state = {
  mode: "comment",
  selection: null,
  currentArticleIndex: 0,
  currentAnnotations: [],
  finalizedArticles: [],
  sessionId: getLocalSessionId(),
};

const modeConfig = {
  comment: {
    primaryLabel: "Factual takeaway",
    primaryPlaceholder:
      "Describe the main factual takeaway from this span in your own words.",
  },
  issue: {
    primaryLabel: "Potential takeaway",
    primaryPlaceholder:
      "What takeaway a reader might reach when reading the content without applying critical thinking or upon a non-careful reading.",
  },
};

const elements = {
  guidelinesScreen: document.getElementById("guidelines-screen"),
  platformScreen: document.getElementById("platform-screen"),
  taskScreen: document.getElementById("task-screen"),
  guidelinesSource: document.querySelector("#guidelines-screen .intro-copy"),
  guidelinesSourceLead: document.querySelector("#guidelines-screen .intro-card > h3"),
  guidelinesContinue: document.getElementById("guidelines-continue"),
  platformBack: document.getElementById("platform-back"),
  platformContinue: document.getElementById("platform-continue"),
  article: document.getElementById("article-content"),
  articleStep: document.getElementById("article-step"),
  articleTitle: document.getElementById("article-title"),
  articleByline: document.getElementById("article-byline"),
  guidelinesToggle: document.getElementById("guidelines-toggle"),
  guidelinesModal: document.getElementById("guidelines-modal"),
  guidelinesModalBackdrop: document.getElementById("guidelines-modal-backdrop"),
  guidelinesModalClose: document.getElementById("guidelines-modal-close"),
  guidelinesModalContent: document.getElementById("guidelines-modal-content"),
  selectedText: document.getElementById("selected-text"),
  primaryCommentLabel: document.getElementById("primary-comment-label"),
  primaryCommentInput: document.getElementById("annotation-comment-primary"),
  secondaryCommentField: document.getElementById("secondary-comment-field"),
  secondaryCommentInput: document.getElementById("annotation-comment-secondary"),
  severityPanel: document.getElementById("severity-panel"),
  severityInput: document.getElementById("severity-input"),
  severityValue: document.getElementById("severity-value"),
  saveButton: document.getElementById("save-annotation"),
  clearButton: document.getElementById("clear-selection"),
  finalizeButton: document.getElementById("finalize-submission"),
  annotationList: document.getElementById("annotation-list"),
  template: document.getElementById("annotation-item-template"),
  participantId: document.getElementById("participant-id"),
  articleId: document.getElementById("article-id"),
  submissionNote: document.getElementById("submission-note"),
  saveStatus: document.getElementById("save-status"),
  output: document.getElementById("submission-output"),
  modeButtons: Array.from(document.querySelectorAll(".mode-button")),
};

elements.guidelinesContinue?.addEventListener("click", () => {
  elements.guidelinesScreen?.classList.add("is-hidden");
  elements.platformScreen?.classList.remove("is-hidden");
  window.scrollTo({ top: 0, behavior: "auto" });
});

elements.platformBack?.addEventListener("click", () => {
  elements.platformScreen?.classList.add("is-hidden");
  elements.guidelinesScreen?.classList.remove("is-hidden");
  window.scrollTo({ top: 0, behavior: "auto" });
});

elements.platformContinue?.addEventListener("click", () => {
  elements.platformScreen?.classList.add("is-hidden");
  elements.taskScreen?.classList.remove("is-hidden");
  window.scrollTo({ top: 0, behavior: "auto" });
});

elements.modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    syncModeUi();
  });
});

elements.guidelinesToggle?.addEventListener("click", () => {
  openGuidelinesModal();
});

elements.guidelinesModalClose?.addEventListener("click", closeGuidelinesModal);
elements.guidelinesModalBackdrop?.addEventListener("click", closeGuidelinesModal);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.guidelinesModal?.classList.contains("is-hidden")) {
    closeGuidelinesModal();
  }
});

elements.severityInput.addEventListener("input", () => {
  elements.severityValue.textContent = elements.severityInput.value;
});

elements.saveButton.addEventListener("click", () => {
  if (!state.selection) {
    window.alert("Select a span in the article before saving.");
    return;
  }

  const primaryComment = elements.primaryCommentInput.value.trim();
  if (!primaryComment) {
    window.alert("Add the first comment before saving.");
    return;
  }

  const secondaryComment =
    state.mode === "issue" ? elements.secondaryCommentInput.value.trim() : "";
  if (state.mode === "issue" && !secondaryComment) {
    window.alert("Add the second comment for issue annotations before saving.");
    return;
  }

  const annotation = {
    id: createId(),
    articleId: getCurrentArticle().id,
    type: state.mode,
    section: state.selection.section,
    text: state.selection.text,
    primaryComment,
    primaryCommentLabel: modeConfig[state.mode].primaryLabel,
    secondaryComment: state.mode === "issue" ? secondaryComment : null,
    start: state.selection.start,
    end: state.selection.end,
    severity: state.mode === "issue" ? Number(elements.severityInput.value) : null,
    createdAt: new Date().toISOString(),
  };

  if (hasOverlap(annotation.section, annotation.start, annotation.end)) {
    window.alert("This prototype does not allow overlapping annotations yet.");
    return;
  }

  const selectionRange = state.selection.range?.cloneRange();
  state.currentAnnotations.push(annotation);
  wrapSelection(annotation, selectionRange);
  clearDraft();
  renderAnnotations();
  renderSubmission();
  scheduleServerSave("annotation-saved");
});

elements.clearButton.addEventListener("click", () => {
  clearDraft();
});

elements.annotationList.addEventListener("click", (event) => {
  const deleteButton = event.target.closest(".annotation-delete");
  if (!deleteButton) {
    return;
  }

  const annotationItem = deleteButton.closest(".annotation-item");
  if (!annotationItem?.dataset.annotationId) {
    return;
  }

  deleteAnnotation(annotationItem.dataset.annotationId);
});

elements.finalizeButton?.addEventListener("click", async () => {
  if (articles.length === 0) {
    window.alert("The article set has not loaded yet.");
    return;
  }

  elements.finalizeButton.disabled = true;
  try {
    await finalizeCurrentArticle();
  } finally {
    if (articles.length > 0 && state.finalizedArticles.length < articles.length) {
      elements.finalizeButton.disabled = false;
    }
  }
});

let selectionCaptureTimer = null;

document.addEventListener("selectionchange", scheduleSelectionCapture);
document.addEventListener("mouseup", scheduleSelectionCapture);
document.addEventListener("dblclick", handleDoubleClickSelection);
document.addEventListener("touchend", scheduleSelectionCapture);
document.addEventListener("keyup", (event) => {
  if (event.key.startsWith("Arrow") || event.key === "Shift") {
    scheduleSelectionCapture();
  }
});

function scheduleSelectionCapture() {
  window.clearTimeout(selectionCaptureTimer);
  selectionCaptureTimer = window.setTimeout(captureCurrentSelection, 80);
}

function handleDoubleClickSelection(event) {
  const range = document.createRange();
  const targetElement =
    event.target.nodeType === Node.ELEMENT_NODE ? event.target : event.target.parentElement;
  const paragraph = targetElement?.closest("#article-content p");

  if (paragraph) {
    range.selectNodeContents(paragraph);
  } else if (elements.articleTitle.contains(event.target)) {
    range.selectNodeContents(elements.articleTitle);
  } else {
    scheduleSelectionCapture();
    return;
  }

  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  captureCurrentSelection();
}

function captureCurrentSelection() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return;
  }

  const range = selection.getRangeAt(0).cloneRange();
  const section = getSelectionSection(range);
  if (!section) {
    return;
  }

  const text = selection.toString().trim();
  if (!text) {
    return;
  }

  const offsets = getSelectionOffsets(range, getSelectionContainer(section));
  if (!offsets) {
    return;
  }

  state.selection = {
    section,
    text,
    start: offsets.start,
    end: offsets.end,
    range,
  };

  elements.selectedText.textContent = `"${text}"`;
}

elements.participantId.addEventListener("input", () => {
  renderSubmission();
  scheduleServerSave("participant-updated");
});
elements.articleId?.addEventListener("input", renderSubmission);

syncModeUi();
renderAnnotations();
renderSubmission();
hydrateGuidelinesModal();
initApp();

async function initApp() {
  setLoadingState();

  try {
    const datasetUrl = `${DATASET_PATH}?v=${encodeURIComponent(DATASET_CACHE_BUSTER)}`;
    const response = await fetch(datasetUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Dataset request failed with status ${response.status}.`);
    }

    const rawJsonl = await response.text();
    const rawArticles = parseJsonlArticles(rawJsonl);
    if (rawArticles.length === 0) {
      throw new Error("The dataset file does not contain any articles.");
    }

    articles = rawArticles.map((article, index) => ({
      id: `qualification${index}-${article.id}`,
      title: article.heading,
      byline: buildByline(article),
      paragraphs: splitRawTextIntoParagraphs(article.text),
    }));

    state.currentArticleIndex = 0;
    state.currentAnnotations = [];
    state.finalizedArticles = [];
    clearDraft();
    showSubmissionNote("", false);
    setSaveStatus("Server autosave will start after your first annotation.", false);
    loadCurrentArticle();
  } catch (error) {
    showDatasetError(error);
  }
}

function setLoadingState() {
  elements.articleStep.textContent = "Loading articles...";
  elements.articleTitle.textContent = "Loading article title...";
  elements.articleByline.textContent = "Loading source information...";
  elements.article.replaceChildren(createParagraph("Article text will appear here when the task loads."));
  elements.finalizeButton.disabled = true;
  elements.saveButton.disabled = true;
  showSubmissionNote(`Loading articles from ${DATASET_PATH}...`, false);
}

function hydrateGuidelinesModal() {
  if (!elements.guidelinesSource || !elements.guidelinesModalContent) {
    return;
  }

  elements.guidelinesModalContent.innerHTML = "";
  if (elements.guidelinesSourceLead) {
    const lead = document.createElement("p");
    lead.className = "modal-lede";
    lead.textContent = elements.guidelinesSourceLead.textContent;
    elements.guidelinesModalContent.appendChild(lead);
  }
  elements.guidelinesModalContent.appendChild(
    elements.guidelinesSource.cloneNode(true),
  );
}

function openGuidelinesModal() {
  if (!elements.guidelinesModal) {
    return;
  }

  hydrateGuidelinesModal();
  elements.guidelinesModal.classList.remove("is-hidden");
  document.body.classList.add("modal-open");
  elements.guidelinesToggle?.setAttribute("aria-expanded", "true");
}

function closeGuidelinesModal() {
  if (!elements.guidelinesModal) {
    return;
  }

  elements.guidelinesModal.classList.add("is-hidden");
  document.body.classList.remove("modal-open");
  elements.guidelinesToggle?.setAttribute("aria-expanded", "false");
}

function showDatasetError(error) {
  const details =
    window.location.protocol === "file:"
      ? `Open the project through a local web server so the browser can read ${DATASET_PATH}.`
      : `Check that ${DATASET_PATH} is present next to index.html and contains valid JSONL.`;

  elements.articleStep.textContent = "Dataset load failed";
  elements.articleTitle.textContent = "Could not load articles";
  elements.articleByline.textContent = "Dataset error";
  elements.article.replaceChildren(
    createParagraph(
      `The app could not load ${DATASET_PATH}. ${details}`,
    ),
  );
  elements.saveButton.disabled = true;
  elements.finalizeButton.disabled = true;
  showSubmissionNote(error.message || String(error), true);
  renderSubmission();
}

function buildByline(article) {
  const parts = [article.source];
  if (article.bias) {
    parts.push(`Bias: ${article.bias}`);
  }

  return parts.join(" | ");
}

function parseJsonlArticles(rawJsonl) {
  return rawJsonl
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((item) => ({
      id: String(item.ID),
      heading: item.heading,
      source: item.source,
      text: item.text,
      bias: item.bias,
    }));
}

function splitRawTextIntoParagraphs(text) {
  return text
    .replace(/\\n/g, "\n")
    .split(/\r?\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function getCurrentArticle() {
  return articles[state.currentArticleIndex];
}

function loadCurrentArticle() {
  const article = getCurrentArticle();
  if (!article) {
    return;
  }

  elements.articleStep.textContent = `Article ${state.currentArticleIndex + 1} of ${articles.length}`;
  elements.articleTitle.textContent = article.title;
  elements.articleByline.textContent = article.byline;
  renderArticleParagraphs(article.paragraphs);
  if (elements.articleId) {
    elements.articleId.value = article.id;
  }
  elements.finalizeButton.textContent =
    state.currentArticleIndex === articles.length - 1
      ? "Finalize full submission"
      : "Finish article and continue";
  elements.finalizeButton.disabled = false;
  elements.saveButton.disabled = false;
  clearDraft();
  renderAnnotations();
  renderSubmission();
}

function renderArticleParagraphs(paragraphs) {
  elements.article.replaceChildren();

  paragraphs.forEach((paragraph) => {
    elements.article.appendChild(createParagraph(paragraph));
  });
}

function createParagraph(text) {
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  return paragraph;
}

function syncModeUi() {
  elements.modeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === state.mode);
  });

  const isIssue = state.mode === "issue";
  elements.severityPanel.classList.toggle("is-hidden", !isIssue);
  elements.secondaryCommentField.classList.toggle("is-hidden", !isIssue);
  elements.primaryCommentLabel.textContent = modeConfig[state.mode].primaryLabel;
  elements.primaryCommentInput.placeholder = modeConfig[state.mode].primaryPlaceholder;
}

function clearDraft() {
  state.selection = null;
  elements.selectedText.textContent = "No text selected yet.";
  elements.primaryCommentInput.value = "";
  elements.secondaryCommentInput.value = "";
  window.getSelection()?.removeAllRanges();
}

function renderAnnotations() {
  elements.annotationList.innerHTML = "";

  if (state.currentAnnotations.length === 0) {
    elements.annotationList.innerHTML =
      '<p class="empty-state">No annotations yet for this article.</p>';
    return;
  }

  state.currentAnnotations.forEach((annotation) => {
    const fragment = elements.template.content.cloneNode(true);
    const root = fragment.querySelector(".annotation-item");
    const chip = fragment.querySelector(".annotation-chip");
    const range = fragment.querySelector(".annotation-range");
    const quote = fragment.querySelector(".annotation-quote");
    const note = fragment.querySelector(".annotation-note");

    const isIssue = annotation.type === "issue";
    chip.textContent = isIssue
      ? `Issue severity ${annotation.severity}/5`
      : "Comment span";
    chip.style.background = isIssue
      ? "rgba(255, 123, 114, 0.18)"
      : "rgba(246, 200, 95, 0.28)";
    chip.style.color = isIssue ? "#8a1e18" : "#9a6500";

    range.textContent = `${capitalizeSection(annotation.section)} ${annotation.start}-${annotation.end}`;
    quote.textContent = `"${annotation.text}"`;
    note.textContent = annotation.secondaryComment
      ? `${annotation.primaryCommentLabel}: ${annotation.primaryComment}\nQuestion(s) to ask: ${annotation.secondaryComment}`
      : `${annotation.primaryCommentLabel}: ${annotation.primaryComment}`;
    note.style.whiteSpace = annotation.secondaryComment ? "pre-line" : "normal";

    root.dataset.annotationId = annotation.id;
    elements.annotationList.appendChild(fragment);
  });
}

function deleteAnnotation(annotationId) {
  const initialCount = state.currentAnnotations.length;
  state.currentAnnotations = state.currentAnnotations.filter(
    (annotation) => annotation.id !== annotationId,
  );

  if (state.currentAnnotations.length === initialCount) {
    return;
  }

  clearDraft();
  refreshAnnotationMarks();
  renderAnnotations();
  renderSubmission();
  scheduleServerSave("annotation-deleted");
}

function refreshAnnotationMarks() {
  const article = getCurrentArticle();
  if (!article) {
    return;
  }

  elements.articleTitle.textContent = article.title;
  renderArticleParagraphs(article.paragraphs);
  state.currentAnnotations.forEach((annotation) => {
    wrapSelection(annotation);
  });
}

function renderSubmission() {
  elements.output.value = JSON.stringify(buildSubmissionPayload(), null, 2);
}

async function finalizeCurrentArticle() {
  const validation = validateAnnotations(state.currentAnnotations);
  if (!validation.ok) {
    showSubmissionNote(validation.message, true);
    window.alert(validation.alertMessage);
    return;
  }

  if (validation.note) {
    showSubmissionNote(validation.note, false);
    const shouldSubmit = window.confirm(`${validation.note} Do you want to continue?`);
    if (!shouldSubmit) {
      return;
    }
  }

  const finalizedArticle = buildArticlePayload(getCurrentArticle(), state.currentAnnotations);
  state.finalizedArticles.push(finalizedArticle);
  renderSubmission();
  await saveSnapshotToServer("article-finalized");

  if (state.currentArticleIndex < articles.length - 1) {
    state.currentArticleIndex += 1;
    state.currentAnnotations = [];
    showSubmissionNote(
      `Article ${state.currentArticleIndex} saved. You can now annotate article ${state.currentArticleIndex + 1}.`,
      false,
    );
    loadCurrentArticle();
    return;
  }

  showSubmissionNote("All articles are complete. Your full submission payload is ready.", false);
  state.currentAnnotations = [];
  renderAnnotations();
  renderSubmission();
  await saveSnapshotToServer("submission-complete");
  window.alert("All articles are complete. You can now submit the full JSON payload.");
}

function buildSubmissionPayload() {
  const currentArticle = articles.length > 0 ? getCurrentArticle() : null;
  const allArticlesCompleted = articles.length > 0 && state.finalizedArticles.length === articles.length;
  const currentArticleIsFinalized = state.finalizedArticles.some(
    (article) => currentArticle && article.articleId === currentArticle.id,
  );

  return {
    participantId: elements.participantId.value.trim(),
    sessionId: state.sessionId,
    totalArticles: articles.length,
    completedArticles: state.finalizedArticles.length,
    currentArticleId: allArticlesCompleted || !currentArticle ? null : currentArticle.id,
    articles:
      allArticlesCompleted || !currentArticle || currentArticleIsFinalized
        ? state.finalizedArticles
        : [
            ...state.finalizedArticles,
            buildArticlePayload(currentArticle, state.currentAnnotations),
          ],
  };
}

function buildArticlePayload(article, annotations) {
  const factualTakeawayCount = getAnnotationCount("comment", annotations);
  const pointOfConcernCount = getAnnotationCount("issue", annotations);

  return {
    articleId: article.id,
    articleTitle: article.title,
    articleText: article.paragraphs.join("\n\n"),
    validation: {
      factualTakeawayCount,
      pointOfConcernCount,
      meetsMinimumFactualTakeaways: factualTakeawayCount >= 2,
      note:
        pointOfConcernCount === 0
          ? "There are no points of concern in this article according to the saved annotations."
          : null,
    },
    annotations,
  };
}

function validateAnnotations(annotations) {
  const factualTakeawayCount = getAnnotationCount("comment", annotations);
  const pointOfConcernCount = getAnnotationCount("issue", annotations);

  if (factualTakeawayCount < 2) {
    return {
      ok: false,
      message: "Please add at least 2 factual takeaways before submitting this article.",
      alertMessage: "You need at least 2 factual takeaways before you can continue.",
    };
  }

  return {
    ok: true,
    note:
      pointOfConcernCount === 0
        ? "Note: there are no points of concern in this article according to your annotations."
        : null,
  };
}

function wrapSelection(annotation, selectionRange) {
  const range =
    selectionRange ||
    createRangeFromOffsets(
      getSelectionContainer(annotation.section),
      annotation.start,
      annotation.end,
    );
  if (!range) {
    return;
  }

  const textRanges = getTextNodeRangesWithinRange(range);

  textRanges.forEach((textRange) => {
    const mark = document.createElement("mark");
    mark.className = "annotation-mark";
    mark.dataset.type = annotation.type;
    mark.dataset.annotationId = annotation.id;
    const content = textRange.extractContents();
    mark.appendChild(content);
    textRange.insertNode(mark);
  });
}

function getTextNodeRangesWithinRange(range) {
  const container = range.commonAncestorContainer;
  const root =
    container.nodeType === Node.TEXT_NODE ? container.parentNode : container;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent.trim()) {
        return NodeFilter.FILTER_REJECT;
      }

      return range.intersectsNode(node)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const textRanges = [];
  let node;

  while ((node = walker.nextNode())) {
    const textRange = document.createRange();
    const startOffset = node === range.startContainer ? range.startOffset : 0;
    const endOffset = node === range.endContainer ? range.endOffset : node.textContent.length;

    if (startOffset === endOffset) {
      continue;
    }

    textRange.setStart(node, startOffset);
    textRange.setEnd(node, endOffset);
    textRanges.push(textRange);
  }

  if (textRanges.length === 0 && range.startContainer === range.endContainer) {
    textRanges.push(range.cloneRange());
  }

  return textRanges.reverse();
}

function getSelectionSection(range) {
  if (isRangeInsideContainer(range, elements.articleTitle)) {
    return "title";
  }

  if (isRangeInsideContainer(range, elements.article)) {
    return "body";
  }

  return null;
}

function isRangeInsideContainer(range, container) {
  return container.contains(range.startContainer) && container.contains(range.endContainer);
}

function getSelectionContainer(section) {
  return section === "title" ? elements.articleTitle : elements.article;
}

function getSelectionOffsets(range, container) {
  const preRange = range.cloneRange();
  preRange.selectNodeContents(container);
  preRange.setEnd(range.startContainer, range.startOffset);

  const start = preRange.toString().length;
  const end = start + range.toString().length;

  return { start, end };
}

function createRangeFromOffsets(container, start, end) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let currentOffset = 0;
  let startSet = false;
  let node;

  while ((node = walker.nextNode())) {
    const nextOffset = currentOffset + node.textContent.length;

    if (!startSet && start >= currentOffset && start <= nextOffset) {
      range.setStart(node, start - currentOffset);
      startSet = true;
    }

    if (startSet && end >= currentOffset && end <= nextOffset) {
      range.setEnd(node, end - currentOffset);
      return range;
    }

    currentOffset = nextOffset;
  }

  return null;
}

function hasOverlap(section, start, end) {
  return state.currentAnnotations.some(
    (annotation) =>
      annotation.section === section && start < annotation.end && end > annotation.start,
  );
}

function capitalizeSection(section) {
  return section.charAt(0).toUpperCase() + section.slice(1);
}

function getAnnotationCount(type, annotations) {
  return annotations.filter((annotation) => annotation.type === type).length;
}

function showSubmissionNote(message, isWarning) {
  if (!message) {
    elements.submissionNote.textContent = "";
    elements.submissionNote.classList.add("is-hidden");
    elements.submissionNote.classList.remove("is-warning");
    return;
  }

  elements.submissionNote.textContent = message;
  elements.submissionNote.classList.remove("is-hidden");
  elements.submissionNote.classList.toggle("is-warning", isWarning);
}

function getLocalSessionId() {
  try {
    const existingSessionId = window.localStorage.getItem(LOCAL_SESSION_KEY);
    if (existingSessionId) {
      return existingSessionId;
    }

    const sessionId = createId();
    window.localStorage.setItem(LOCAL_SESSION_KEY, sessionId);
    return sessionId;
  } catch {
    return createId();
  }
}

function createId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function scheduleServerSave(reason) {
  if (articles.length === 0) {
    return;
  }

  window.clearTimeout(saveDebounceTimer);
  setSaveStatus("Saving annotations to the VM...", false);
  saveDebounceTimer = window.setTimeout(() => {
    saveSnapshotToServer(reason);
  }, SAVE_DEBOUNCE_MS);
}

async function saveSnapshotToServer(reason) {
  if (articles.length === 0) {
    return false;
  }

  try {
    const response = await fetch(ANNOTATION_SAVE_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        reason,
        participantId: elements.participantId.value.trim(),
        sessionId: state.sessionId,
        payload: buildSubmissionPayload(),
      }),
    });

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}.`);
    }

    const result = await response.json();
    setSaveStatus(`Saved on VM: ${result.latestFile}`, false);
    return true;
  } catch (error) {
    setSaveStatus(
      `VM autosave is unavailable. The JSON below is still current. (${error.message || error})`,
      true,
    );
    return false;
  }
}

function setSaveStatus(message, isWarning) {
  if (!elements.saveStatus) {
    return;
  }

  elements.saveStatus.textContent = message;
  elements.saveStatus.classList.toggle("is-warning", isWarning);
}
