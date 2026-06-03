const DATASET_PATH = "./samplefrom5withkeys.jsonl";
const DATASET_CACHE_BUSTER = "article-choice-sample-20260603";
const ANNOTATION_SAVE_PATH = "/api/annotations/save";
const LOCAL_SESSION_KEY = "annotation_task_session_id";
const TASK_VERSION = "article-choice-task-20260603";
const ARTICLE_CHOICES_PER_ROUND = 4;
const ARTICLES_PER_TASK = 5;
const SAVE_DEBOUNCE_MS = 700;

let articleCandidates = [];
let articles = [];
let saveDebounceTimer = null;

const state = {
  mode: "comment",
  selection: null,
  currentArticleIndex: 0,
  currentChoiceOptions: [],
  currentAnnotations: [],
  finalizedArticles: [],
  qualificationFeedback: "",
  pasteCounts: {
    takeaway: 0,
    question: 0,
  },
  sessionId: getLocalSessionId(),
  runId: "",
  startTime: null,
  endTime: null,
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
  choiceScreen: document.getElementById("choice-screen"),
  taskScreen: document.getElementById("task-screen"),
  completionScreen: document.getElementById("completion-screen"),
  guidelinesSource: document.querySelector("#guidelines-screen .intro-copy"),
  guidelinesSourceLead: document.querySelector("#guidelines-screen .intro-card > h3"),
  platformSource: document.querySelector("#platform-screen .intro-card"),
  guidelinesContinue: document.getElementById("guidelines-continue"),
  platformBack: document.getElementById("platform-back"),
  platformContinue: document.getElementById("platform-continue"),
  choiceStep: document.getElementById("choice-step"),
  articleChoiceList: document.getElementById("article-choice-list"),
  article: document.getElementById("article-content"),
  articleStep: document.getElementById("article-step"),
  articleTitle: document.getElementById("article-title"),
  articleByline: document.getElementById("article-byline"),
  guidelinesToggle: document.getElementById("guidelines-toggle"),
  guidelinesModal: document.getElementById("guidelines-modal"),
  guidelinesModalBackdrop: document.getElementById("guidelines-modal-backdrop"),
  guidelinesModalClose: document.getElementById("guidelines-modal-close"),
  guidelinesModalContent: document.getElementById("guidelines-modal-content"),
  platformToggle: document.getElementById("platform-toggle"),
  platformModal: document.getElementById("platform-modal"),
  platformModalBackdrop: document.getElementById("platform-modal-backdrop"),
  platformModalClose: document.getElementById("platform-modal-close"),
  platformModalContent: document.getElementById("platform-modal-content"),
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
  articleScopeField: document.getElementById("article-scope-field"),
  articleScopeCheckbox: document.getElementById("article-scope-checkbox"),
  finalizeButton: document.getElementById("finalize-submission"),
  annotationList: document.getElementById("annotation-list"),
  template: document.getElementById("annotation-item-template"),
  participantId: document.getElementById("participant-id"),
  articleId: document.getElementById("article-id"),
  submissionNote: document.getElementById("submission-note"),
  output: document.getElementById("submission-output"),
  modeButtons: Array.from(document.querySelectorAll(".mode-button")),
  freeformModal: document.getElementById("freeform-modal"),
  freeformEyebrow: document.getElementById("freeform-modal-eyebrow"),
  freeformTitle: document.getElementById("freeform-modal-title"),
  freeformDescription: document.getElementById("freeform-modal-description"),
  freeformParticipantField: document.getElementById("freeform-modal-participant-field"),
  freeformParticipantId: document.getElementById("freeform-modal-participant-id"),
  freeformLabel: document.getElementById("freeform-modal-label"),
  freeformInput: document.getElementById("freeform-modal-input"),
  freeformResponseField: document.getElementById("freeform-modal-input")?.closest(".field"),
  freeformError: document.getElementById("freeform-modal-error"),
  freeformSkip: document.getElementById("freeform-modal-skip"),
  freeformSubmit: document.getElementById("freeform-modal-submit"),
  editAnnotationModal: document.getElementById("edit-annotation-modal"),
  editAnnotationBackdrop: document.getElementById("edit-annotation-modal-backdrop"),
  editAnnotationText: document.getElementById("edit-annotation-text"),
  editPrimaryLabel: document.getElementById("edit-primary-label"),
  editPrimaryComment: document.getElementById("edit-primary-comment"),
  editSecondaryField: document.getElementById("edit-secondary-field"),
  editSecondaryComment: document.getElementById("edit-secondary-comment"),
  editSeverityPanel: document.getElementById("edit-severity-panel"),
  editSeverityInput: document.getElementById("edit-severity-input"),
  editSeverityValue: document.getElementById("edit-severity-value"),
  editAnnotationError: document.getElementById("edit-annotation-error"),
  editAnnotationCancelTop: document.getElementById("edit-annotation-cancel-top"),
  editAnnotationCancel: document.getElementById("edit-annotation-cancel"),
  editAnnotationSave: document.getElementById("edit-annotation-save"),
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
  showArticleChoiceScreen();
});

elements.articleChoiceList?.addEventListener("click", (event) => {
  const choiceCard = event.target.closest(".article-choice-card");
  if (!choiceCard?.dataset.articleId) {
    return;
  }

  chooseArticle(choiceCard.dataset.articleId);
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

elements.platformToggle?.addEventListener("click", () => {
  openPlatformModal();
});

elements.platformModalClose?.addEventListener("click", closePlatformModal);
elements.platformModalBackdrop?.addEventListener("click", closePlatformModal);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.guidelinesModal?.classList.contains("is-hidden")) {
    closeGuidelinesModal();
  }

  if (event.key === "Escape" && !elements.platformModal?.classList.contains("is-hidden")) {
    closePlatformModal();
  }

  if (
    event.key === "Escape" &&
    !elements.editAnnotationModal?.classList.contains("is-hidden")
  ) {
    closeEditAnnotationModal();
  }
});

elements.severityInput.addEventListener("input", () => {
  elements.severityValue.textContent = elements.severityInput.value;
});

elements.editSeverityInput?.addEventListener("input", () => {
  elements.editSeverityValue.textContent = elements.editSeverityInput.value;
});

elements.articleScopeCheckbox?.addEventListener("change", syncArticleScopeUi);

elements.saveButton.addEventListener("click", () => {
  const isArticleScope = isArticleScopeSelected();
  if (!state.selection && !isArticleScope) {
    const alertMessage =
      state.mode === "issue"
        ? "Select a span in the article or mark that the concern applies to the entire article before saving."
        : "Select a span in the article before saving.";
    window.alert(alertMessage);
    return;
  }

  const primaryComment = elements.primaryCommentInput.value.trim();
  if (!primaryComment) {
    window.alert("Add a takeaway before saving.");
    return;
  }

  const secondaryComment =
    state.mode === "issue" ? elements.secondaryCommentInput.value.trim() : "";
  if (state.mode === "issue" && !secondaryComment) {
    window.alert("Add the question before saving.");
    return;
  }

  const annotation = {
    id: createId(),
    articleId: getCurrentArticle().id,
    type: state.mode,
    scope: isArticleScope ? "article" : "span",
    section: isArticleScope ? "article" : state.selection.section,
    text: isArticleScope ? "Entire article" : state.selection.text,
    primaryComment,
    primaryCommentLabel: modeConfig[state.mode].primaryLabel,
    secondaryComment: state.mode === "issue" ? secondaryComment : null,
    start: isArticleScope ? null : state.selection.start,
    end: isArticleScope ? null : state.selection.end,
    severity: state.mode === "issue" ? Number(elements.severityInput.value) : null,
    createdAt: new Date().toISOString(),
  };

  state.currentAnnotations.push(annotation);
  if (!isArticleScope) {
    refreshAnnotationMarks();
  }
  clearDraft();
  renderAnnotations();
  renderSubmission();
  scheduleServerSave("annotation-saved");
});

elements.clearButton.addEventListener("click", () => {
  clearDraft();
});

elements.annotationList.addEventListener("click", (event) => {
  const editButton = event.target.closest(".annotation-edit");
  if (editButton) {
    const annotationItem = editButton.closest(".annotation-item");
    if (annotationItem?.dataset.annotationId) {
      openEditAnnotationModal(annotationItem.dataset.annotationId);
    }
    return;
  }

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

elements.editAnnotationSave?.addEventListener("click", saveEditedAnnotation);
elements.editAnnotationCancel?.addEventListener("click", closeEditAnnotationModal);
elements.editAnnotationCancelTop?.addEventListener("click", closeEditAnnotationModal);
elements.editAnnotationBackdrop?.addEventListener("click", closeEditAnnotationModal);

elements.primaryCommentInput?.addEventListener("paste", () => recordPaste("takeaway"));
elements.secondaryCommentInput?.addEventListener("paste", () => recordPaste("question"));
elements.editPrimaryComment?.addEventListener("paste", () => recordPaste("takeaway"));
elements.editSecondaryComment?.addEventListener("paste", () => recordPaste("question"));

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

  if (elements.articleScopeCheckbox?.checked) {
    elements.articleScopeCheckbox.checked = false;
  }
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
hydratePlatformModal();
showParticipantIdPrompt();
initApp();

async function initApp() {
  setLoadingState();

  try {
    const datasetUrl = `${DATASET_PATH}?v=${encodeURIComponent(DATASET_CACHE_BUSTER)}`;
    const response = await fetch(datasetUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Dataset request failed with status ${response.status}.`);
    }

    const rawDataset = await response.text();
    const rawArticles = parseDatasetArticles(rawDataset);
    if (rawArticles.length === 0) {
      throw new Error("The dataset file does not contain any articles.");
    }

    articleCandidates = rawArticles.map(normalizeArticle).filter(Boolean);

    state.currentArticleIndex = 0;
    state.currentChoiceOptions = [];
    state.currentAnnotations = [];
    state.finalizedArticles = [];
    articles = [];
    clearDraft();
    showSubmissionNote("", false);
    renderSubmission();
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

function showGuidelinesScreen() {
  elements.freeformModal?.classList.add("is-hidden");
  document.body.classList.remove("modal-open");
  elements.guidelinesScreen?.classList.remove("is-hidden");
  elements.platformScreen?.classList.add("is-hidden");
  elements.choiceScreen?.classList.add("is-hidden");
  elements.taskScreen?.classList.add("is-hidden");
  elements.completionScreen?.classList.add("is-hidden");
  window.scrollTo({ top: 0, behavior: "auto" });
}

function hydratePlatformModal() {
  if (!elements.platformSource || !elements.platformModalContent) {
    return;
  }

  elements.platformModalContent.innerHTML = "";
  const titleCopy = elements.platformSource.querySelector(".walkthrough-title-block p:not(.eyebrow)");
  if (titleCopy) {
    const lead = document.createElement("p");
    lead.className = "modal-lede";
    lead.textContent = titleCopy.textContent;
    elements.platformModalContent.appendChild(lead);
  }

  [".walkthrough-video-section", ".walkthrough-stack"].forEach((selector) => {
    const sourceNode = elements.platformSource.querySelector(selector);
    if (!sourceNode) {
      return;
    }

    const clone = sourceNode.cloneNode(true);
    clone.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    elements.platformModalContent.appendChild(clone);
  });
}

function openPlatformModal() {
  if (!elements.platformModal) {
    return;
  }

  hydratePlatformModal();
  elements.platformModal.classList.remove("is-hidden");
  document.body.classList.add("modal-open");
  elements.platformToggle?.setAttribute("aria-expanded", "true");
}

function closePlatformModal() {
  if (!elements.platformModal) {
    return;
  }

  elements.platformModal.classList.add("is-hidden");
  document.body.classList.remove("modal-open");
  elements.platformToggle?.setAttribute("aria-expanded", "false");
}

function showDatasetError(error) {
  const details =
    window.location.protocol === "file:"
      ? `Open the project through a local web server so the browser can read ${DATASET_PATH}.`
      : `Check that ${DATASET_PATH} is present next to index.html and contains article records.`;

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

function parseDatasetArticles(rawDataset) {
  const trimmedDataset = rawDataset.trim();
  if (!trimmedDataset) {
    return [];
  }

  try {
    const parsedDataset = JSON.parse(trimmedDataset);
    if (Array.isArray(parsedDataset)) {
      return parsedDataset;
    }

    for (const key of ["records", "articles", "data", "items"]) {
      if (Array.isArray(parsedDataset?.[key])) {
        return parsedDataset[key];
      }
    }

    return [];
  } catch {
    return trimmedDataset
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

function normalizeArticle(item, index) {
  const heading = item.heading || item.title || item.headline || "";
  const text = item.text || item.body || item.articleText || item.content || "";

  if (!heading || !text) {
    return null;
  }

  const rawId = item.ID ?? item.id ?? item.articleId ?? index;
  const source = item.source || item.publisher || item.outlet || "";

  return {
    id: `candidate${index}-${String(rawId)}`,
    originalId: String(rawId),
    title: heading,
    source,
    byline: buildByline({
      source,
      bias: item.bias,
    }),
    paragraphs: splitRawTextIntoParagraphs(text),
    bias: item.bias || null,
    url: item.url || null,
  };
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

function getTargetArticleCount() {
  return Math.min(ARTICLES_PER_TASK, articles.length + articleCandidates.length);
}

function getArticleChoiceSummary(article) {
  const summaryText = article.paragraphs.join(" ");
  return summaryText.length > 220 ? `${summaryText.slice(0, 220).trim()}...` : summaryText;
}

function pickArticleOptions() {
  return [...articleCandidates]
    .sort(() => Math.random() - 0.5)
    .slice(0, Math.min(ARTICLE_CHOICES_PER_ROUND, articleCandidates.length));
}

function showArticleChoiceScreen() {
  if (articleCandidates.length === 0) {
    window.alert("No articles are available to choose from.");
    return;
  }

  state.currentChoiceOptions = pickArticleOptions();
  elements.articleChoiceList.replaceChildren();
  elements.choiceStep.textContent =
    `Article ${state.finalizedArticles.length + 1} of ${getTargetArticleCount()}`;

  state.currentChoiceOptions.forEach((article) => {
    const button = document.createElement("button");
    button.className = "article-choice-card";
    button.type = "button";
    button.dataset.articleId = article.id;

    const title = document.createElement("h3");
    title.textContent = article.title;

    const summary = document.createElement("p");
    summary.className = "article-choice-summary";
    summary.textContent = getArticleChoiceSummary(article);

    button.append(title, summary);
    elements.articleChoiceList.appendChild(button);
  });

  elements.guidelinesScreen?.classList.add("is-hidden");
  elements.platformScreen?.classList.add("is-hidden");
  elements.choiceScreen?.classList.remove("is-hidden");
  elements.taskScreen?.classList.add("is-hidden");
  elements.completionScreen?.classList.add("is-hidden");
  window.scrollTo({ top: 0, behavior: "auto" });
}

function chooseArticle(articleId) {
  const selectedArticle = state.currentChoiceOptions.find((article) => article.id === articleId);
  if (!selectedArticle) {
    return;
  }

  articleCandidates = articleCandidates.filter((article) => article.id !== selectedArticle.id);
  articles.push({
    ...selectedArticle,
    choiceSet: state.currentChoiceOptions.map((article) => ({
      articleId: article.id,
      originalId: article.originalId,
      title: article.title,
      source: article.source,
      bias: article.bias,
      url: article.url,
    })),
  });
  state.currentArticleIndex = articles.length - 1;
  state.currentChoiceOptions = [];
  state.currentAnnotations = [];

  elements.choiceScreen?.classList.add("is-hidden");
  elements.taskScreen?.classList.remove("is-hidden");
  loadCurrentArticle();
  window.scrollTo({ top: 0, behavior: "auto" });
}

function loadCurrentArticle() {
  const article = getCurrentArticle();
  if (!article) {
    return;
  }

  elements.articleStep.textContent = `Article ${state.finalizedArticles.length + 1} of ${getTargetArticleCount()}`;
  elements.articleTitle.textContent = article.title;
  elements.articleByline.textContent = "";
  renderArticleParagraphs(article.paragraphs);
  if (elements.articleId) {
    elements.articleId.value = article.id;
  }
  elements.finalizeButton.textContent =
    state.finalizedArticles.length + 1 >= getTargetArticleCount()
      ? "Finalize full submission"
      : "Finish article and continue";
  elements.finalizeButton.disabled = false;
  elements.saveButton.disabled = false;
  clearDraft();
  renderAnnotations();
  renderSubmission();
}

function renderArticleParagraphs(paragraphs) {
  renderAnnotatedBody(paragraphs);
}

function createParagraph(text) {
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  return paragraph;
}

function renderAnnotatedBody(paragraphs) {
  elements.article.replaceChildren();

  let startOffset = 0;
  paragraphs.forEach((paragraphText) => {
    const paragraph = document.createElement("p");
    renderAnnotatedText(paragraph, paragraphText, "body", startOffset);
    elements.article.appendChild(paragraph);
    startOffset += paragraphText.length;
  });
}

function renderAnnotatedText(container, text, section, baseOffset) {
  container.replaceChildren();
  const boundaries = getAnnotationBoundaries(text.length, section, baseOffset);

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const content = text.slice(start, end);
    if (!content) {
      continue;
    }

    const annotation = getLatestAnnotationForRange(section, baseOffset + start, baseOffset + end);
    if (!annotation) {
      container.appendChild(document.createTextNode(content));
      continue;
    }

    const mark = document.createElement("mark");
    mark.className = "annotation-mark";
    mark.dataset.type = annotation.type;
    mark.dataset.annotationId = annotation.id;
    mark.textContent = content;
    container.appendChild(mark);
  }
}

function getAnnotationBoundaries(textLength, section, baseOffset) {
  const boundaries = new Set([0, textLength]);
  const sectionStart = baseOffset;
  const sectionEnd = baseOffset + textLength;

  state.currentAnnotations.forEach((annotation) => {
    if (
      annotation.scope === "article" ||
      annotation.section !== section ||
      annotation.end <= sectionStart ||
      annotation.start >= sectionEnd
    ) {
      return;
    }

    boundaries.add(Math.max(annotation.start, sectionStart) - baseOffset);
    boundaries.add(Math.min(annotation.end, sectionEnd) - baseOffset);
  });

  return Array.from(boundaries).sort((first, second) => first - second);
}

function getLatestAnnotationForRange(section, start, end) {
  for (let index = state.currentAnnotations.length - 1; index >= 0; index -= 1) {
    const annotation = state.currentAnnotations[index];
    if (
      annotation.scope !== "article" &&
      annotation.section === section &&
      annotation.start < end &&
      annotation.end > start
    ) {
      return annotation;
    }
  }

  return null;
}

function syncModeUi() {
  elements.modeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === state.mode);
  });

  const isIssue = state.mode === "issue";
  elements.severityPanel.classList.toggle("is-hidden", !isIssue);
  elements.secondaryCommentField.classList.toggle("is-hidden", !isIssue);
  elements.articleScopeField?.classList.toggle("is-hidden", !isIssue);
  elements.primaryCommentLabel.textContent = modeConfig[state.mode].primaryLabel;
  elements.primaryCommentInput.placeholder = modeConfig[state.mode].primaryPlaceholder;
  if (!isIssue && elements.articleScopeCheckbox?.checked) {
    elements.articleScopeCheckbox.checked = false;
    syncArticleScopeUi();
  }
}

function clearDraft() {
  state.selection = null;
  elements.selectedText.textContent = "No text selected yet.";
  elements.primaryCommentInput.value = "";
  elements.secondaryCommentInput.value = "";
  if (elements.articleScopeCheckbox) {
    elements.articleScopeCheckbox.checked = false;
  }
  window.getSelection()?.removeAllRanges();
}

function isArticleScopeSelected() {
  return state.mode === "issue" && Boolean(elements.articleScopeCheckbox?.checked);
}

function syncArticleScopeUi() {
  if (!isArticleScopeSelected()) {
    if (!state.selection) {
      elements.selectedText.textContent = "No text selected yet.";
    }
    return;
  }

  state.selection = null;
  window.getSelection()?.removeAllRanges();
  elements.selectedText.textContent = "Entire article";
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
      : "Factual Takeaway";
    chip.style.background = isIssue
      ? "rgba(255, 123, 114, 0.18)"
      : "rgba(246, 200, 95, 0.28)";
    chip.style.color = isIssue ? "#8a1e18" : "#9a6500";

    const isArticleScope = annotation.scope === "article";
    range.textContent = isArticleScope
      ? "Entire article"
      : `${capitalizeSection(annotation.section)} ${annotation.start}-${annotation.end}`;
    quote.textContent = isArticleScope ? "Entire article" : `"${annotation.text}"`;
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

function openEditAnnotationModal(annotationId) {
  const annotation = state.currentAnnotations.find((item) => item.id === annotationId);
  if (!annotation || !elements.editAnnotationModal) {
    return;
  }

  const isIssue = annotation.type === "issue";
  elements.editAnnotationModal.dataset.annotationId = annotation.id;
  elements.editAnnotationText.textContent =
    annotation.scope === "article" ? "Entire article" : `"${annotation.text}"`;
  elements.editPrimaryLabel.textContent = annotation.primaryCommentLabel;
  elements.editPrimaryComment.value = annotation.primaryComment;
  elements.editSecondaryField.classList.toggle("is-hidden", !isIssue);
  elements.editSecondaryComment.value = isIssue ? annotation.secondaryComment || "" : "";
  elements.editSeverityPanel.classList.toggle("is-hidden", !isIssue);
  elements.editSeverityInput.value = isIssue ? String(annotation.severity || 3) : "3";
  elements.editSeverityValue.textContent = elements.editSeverityInput.value;
  elements.editAnnotationError.textContent = "";
  elements.editAnnotationError.classList.add("is-hidden");

  elements.editAnnotationModal.classList.remove("is-hidden");
  document.body.classList.add("modal-open");
  window.setTimeout(() => elements.editPrimaryComment.focus(), 0);
}

function closeEditAnnotationModal() {
  if (!elements.editAnnotationModal) {
    return;
  }

  elements.editAnnotationModal.classList.add("is-hidden");
  elements.editAnnotationModal.dataset.annotationId = "";
  document.body.classList.remove("modal-open");
}

function saveEditedAnnotation() {
  const annotationId = elements.editAnnotationModal?.dataset.annotationId;
  const annotation = state.currentAnnotations.find((item) => item.id === annotationId);
  if (!annotation) {
    closeEditAnnotationModal();
    return;
  }

  const primaryComment = elements.editPrimaryComment.value.trim();
  if (!primaryComment) {
    showEditAnnotationError("Add the first comment before saving changes.");
    elements.editPrimaryComment.focus();
    return;
  }

  const isIssue = annotation.type === "issue";
  const secondaryComment = isIssue ? elements.editSecondaryComment.value.trim() : "";
  if (isIssue && !secondaryComment) {
    showEditAnnotationError("Add the question before saving changes.");
    elements.editSecondaryComment.focus();
    return;
  }

  annotation.primaryComment = primaryComment;
  annotation.secondaryComment = isIssue ? secondaryComment : null;
  annotation.severity = isIssue ? Number(elements.editSeverityInput.value) : null;
  annotation.updatedAt = new Date().toISOString();

  closeEditAnnotationModal();
  renderAnnotations();
  renderSubmission();
  scheduleServerSave("annotation-edited");
}

function showEditAnnotationError(message) {
  elements.editAnnotationError.textContent = message;
  elements.editAnnotationError.classList.remove("is-hidden");
}

function refreshAnnotationMarks() {
  const article = getCurrentArticle();
  if (!article) {
    return;
  }

  renderAnnotatedText(elements.articleTitle, article.title, "title", 0);
  renderAnnotatedBody(article.paragraphs);
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

  if (state.finalizedArticles.length < getTargetArticleCount()) {
    state.currentAnnotations = [];
    showSubmissionNote(
      `Article ${state.finalizedArticles.length} saved. Choose the next article to annotate.`,
      false,
    );
    showArticleChoiceScreen();
    return;
  }

  await showQualificationFeedbackPrompt();

  markTaskCompleted();
  showSubmissionNote("All articles are complete. Your responses have been saved.", false);
  state.currentAnnotations = [];
  renderAnnotations();
  renderSubmission();
  await saveSnapshotToServer("submission-complete");
  showCompletionScreen();
}

function showCompletionScreen() {
  elements.guidelinesScreen?.classList.add("is-hidden");
  elements.platformScreen?.classList.add("is-hidden");
  elements.choiceScreen?.classList.add("is-hidden");
  elements.taskScreen?.classList.add("is-hidden");
  elements.completionScreen?.classList.remove("is-hidden");
  window.scrollTo({ top: 0, behavior: "auto" });
}

function buildSubmissionPayload() {
  const currentArticle = articles.length > 0 ? getCurrentArticle() : null;
  const targetArticleCount = getTargetArticleCount();
  const allArticlesCompleted = targetArticleCount > 0 && state.finalizedArticles.length >= targetArticleCount;
  const currentArticleIsFinalized = state.finalizedArticles.some(
    (article) => currentArticle && article.articleId === currentArticle.id,
  );

  return {
    participantId: elements.participantId.value.trim(),
    sessionId: state.sessionId,
    runId: state.runId,
    taskVersion: TASK_VERSION,
    datasetVersion: DATASET_CACHE_BUSTER,
    startTime: state.startTime,
    endTime: state.endTime,
    durationSeconds: getTaskDurationSeconds(),
    qualificationFeedback: state.qualificationFeedback,
    pasteCounts: {
      ...state.pasteCounts,
    },
    totalArticles: targetArticleCount,
    completedArticles: state.finalizedArticles.length,
    availableArticleChoices: articleCandidates.length,
    pendingChoiceOptions: state.currentChoiceOptions.map((article) => ({
      articleId: article.id,
      originalId: article.originalId,
      title: article.title,
      source: article.source,
      bias: article.bias,
      url: article.url,
    })),
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

function markTaskStarted() {
  if (!state.startTime) {
    state.startTime = new Date().toISOString();
  }
}

function markTaskCompleted() {
  if (!state.endTime) {
    state.endTime = new Date().toISOString();
  }
}

function getTaskDurationSeconds() {
  if (!state.startTime) {
    return null;
  }

  const endTime = state.endTime || new Date().toISOString();
  const elapsedMilliseconds = new Date(endTime).getTime() - new Date(state.startTime).getTime();
  if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds < 0) {
    return null;
  }

  return Math.round(elapsedMilliseconds / 1000);
}

function buildArticlePayload(article, annotations) {
  const factualTakeawayCount = getAnnotationCount("comment", annotations);
  const pointOfConcernCount = getAnnotationCount("issue", annotations);

  return {
    articleId: article.id,
    originalArticleId: article.originalId,
    articleTitle: article.title,
    articleSource: article.source,
    articleUrl: article.url,
    choiceSet: article.choiceSet || [],
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

async function showParticipantIdPrompt() {
  const response = await openFreeformPrompt({
    eyebrow: "Before you begin",
    title: "Participant details",
    description: "Please enter your participant ID before starting the task.",
    label: "",
    placeholder: "",
    submitLabel: "Continue",
    required: true,
    includeParticipantId: true,
    hideResponse: true,
    errorMessage: "Please enter your participant ID before continuing.",
  });


  elements.participantId.value = response.participantId;
  state.runId = createRunId();
  showGuidelinesScreen();
  markTaskStarted();
  renderSubmission();
  scheduleServerSave("participant-id-added");
}

async function showQualificationFeedbackPrompt() {
  const response = await openFreeformPrompt({
    eyebrow: "Optional feedback",
    title: "Task feedback",
    description: "Thank you so much for participating! We’d really appreciate any feedback you may have about the qualification task or the platform.",
    label: "Feedback",
    placeholder: "Optional",
    submitLabel: "Submit feedback",
    skipLabel: "Skip",
    required: false,
  });

  state.qualificationFeedback = response;
  renderSubmission();
  await saveSnapshotToServer("qualification-feedback-added");
}

function openFreeformPrompt(config) {
  if (!elements.freeformModal) {
    return Promise.resolve("");
  }

  elements.freeformEyebrow.textContent = config.eyebrow;
  elements.freeformTitle.textContent = config.title;
  elements.freeformDescription.textContent = config.description;
  elements.freeformParticipantField.classList.toggle(
    "is-hidden",
    !config.includeParticipantId,
  );
  elements.freeformParticipantId.value = config.includeParticipantId
    ? elements.participantId.value.trim()
    : "";
  elements.freeformLabel.textContent = config.label;
  elements.freeformInput.value = "";
  elements.freeformInput.placeholder = config.placeholder || "";
  elements.freeformResponseField?.classList.toggle("is-hidden", Boolean(config.hideResponse));
  elements.freeformSubmit.textContent = config.submitLabel || "Continue";
  elements.freeformSkip.textContent = config.skipLabel || "Skip";
  elements.freeformSkip.classList.toggle("is-hidden", config.required);
  elements.freeformError.textContent = "";
  elements.freeformError.classList.add("is-hidden");

  elements.freeformModal.classList.remove("is-hidden");
  document.body.classList.add("modal-open");
  window.setTimeout(() => {
    if (config.includeParticipantId && !elements.freeformParticipantId.value.trim()) {
      elements.freeformParticipantId.focus();
      return;
    }

    if (!config.hideResponse) {
      elements.freeformInput.focus();
    }
  }, 0);

  return new Promise((resolve) => {
    const cleanup = () => {
      elements.freeformModal.classList.add("is-hidden");
      document.body.classList.remove("modal-open");
      elements.freeformSubmit.removeEventListener("click", handleSubmit);
      elements.freeformSkip.removeEventListener("click", handleSkip);
      document.removeEventListener("keydown", handleKeydown);
    };

    const finish = (value, participantId = "") => {
      cleanup();
      if (config.includeParticipantId) {
        resolve({
          participantId: participantId.trim(),
          text: value.trim(),
        });
        return;
      }

      resolve(value.trim());
    };

    const handleSubmit = () => {
      const value = config.hideResponse ? "" : elements.freeformInput.value.trim();
      const participantId = elements.freeformParticipantId.value.trim();
      if (
        config.required &&
        ((!config.hideResponse && !value) || (config.includeParticipantId && !participantId))
      ) {
        elements.freeformError.textContent =
          config.hideResponse
            ? "Please enter your participant ID before continuing."
            : config.errorMessage || "Please enter a response.";
        elements.freeformError.classList.remove("is-hidden");
        if (config.includeParticipantId && !participantId) {
          elements.freeformParticipantId.focus();
        } else {
          elements.freeformInput.focus();
        }
        return;
      }

      finish(value, participantId);
    };

    const handleSkip = () => {
      if (!config.required) {
        finish("");
      }
    };

    const handleKeydown = (event) => {
      if (event.key === "Escape" && !config.required) {
        handleSkip();
      }
    };

    elements.freeformSubmit.addEventListener("click", handleSubmit);
    elements.freeformSkip.addEventListener("click", handleSkip);
    document.addEventListener("keydown", handleKeydown);
  });
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
  const start = getTextOffset(container, range.startContainer, range.startOffset);
  const end = getTextOffset(container, range.endContainer, range.endOffset);

  if (start === null || end === null) {
    return null;
  }

  return { start, end };
}

function getTextOffset(container, boundaryNode, boundaryOffset) {
  const result = getTextOffsetFromNode(container, boundaryNode, boundaryOffset, 0);

  return result.found ? result.offset : null;
}

function getTextOffsetFromNode(node, boundaryNode, boundaryOffset, currentOffset) {
  if (node === boundaryNode) {
    if (node.nodeType === Node.TEXT_NODE) {
      return {
        found: true,
        offset: currentOffset + boundaryOffset,
      };
    }

    let offset = currentOffset;
    for (let index = 0; index < boundaryOffset; index += 1) {
      offset += getNodeTextLength(node.childNodes[index]);
    }

    return { found: true, offset };
  }

  if (node.nodeType === Node.TEXT_NODE) {
    return {
      found: false,
      offset: currentOffset + node.textContent.length,
    };
  }

  let offset = currentOffset;
  for (const childNode of node.childNodes) {
    const result = getTextOffsetFromNode(childNode, boundaryNode, boundaryOffset, offset);
    if (result.found) {
      return result;
    }
    offset = result.offset;
  }

  return { found: false, offset };
}

function getNodeTextLength(node) {
  return node ? node.textContent.length : 0;
}

function capitalizeSection(section) {
  return section.charAt(0).toUpperCase() + section.slice(1);
}

function getAnnotationCount(type, annotations) {
  return annotations.filter((annotation) => annotation.type === type).length;
}

function recordPaste(field) {
  if (!Object.prototype.hasOwnProperty.call(state.pasteCounts, field)) {
    return;
  }

  state.pasteCounts[field] += 1;
  renderSubmission();
  scheduleServerSave(`${field}-pasted`);
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

function createRunId() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}_${createId()}`;
}

function scheduleServerSave(reason) {
  if (articles.length === 0) {
    return;
  }

  window.clearTimeout(saveDebounceTimer);
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
        runId: state.runId,
        payload: buildSubmissionPayload(),
      }),
    });

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}.`);
    }

    await response.json();
    return true;
  } catch (error) {
    return false;
  }
}
