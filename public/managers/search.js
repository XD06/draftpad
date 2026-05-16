

export default class SearchManager {
  constructor(fetchWithPin, selectNotepad, closeModals) {
    this.fetchWithPin = fetchWithPin;
    this.selectNotepad = selectNotepad;
    this.closeModals = closeModals;
    this.cache = {};
    this.page = 1;
    this.query = "";
    this.selectedIndex = -1;
    this.searchModal = document.getElementById("search-modal");
    this.searchBox = document.getElementById("search-box");
    this.searchResults = document.getElementById("search-results");
    this.resultItems = this.searchResults.querySelectorAll("li");
    this.openSearchBtn = document.getElementById("search-open");
  }

  debounce(func, delay = 300) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => func(...args), delay);
    }
  }

  async search(newQuery, newPage = 1) {
    if (newQuery !== this.query) {
      this.page = 1;
      this.selectedIndex = -1;
      this.cache = {}; // resets the cache for new queries
      this.clearResults();
    }

    this.query = newQuery;

    if(this.cache[`${this.query}-${this.page}`])
      return this.displayResults(this.cache[`${this.query}-${this.page}`]);

    const response = await this.fetchWithPin(`/api/search?query=${encodeURIComponent(this.query)}&page=${newPage}`);
    const results = await response.json();
    this.cache[`${this.query}-${this.page}`] = results;
    this.displayResults(results);
  }

  highlightMatch(text) {
    const escaped = this.escapeHtml(text);
    return escaped.replace(new RegExp(this.escapeRegExp(this.query), "gi"), (match) => `<mark>${match}</mark>`);
  }

  escapeHtml(text = "") {
    return String(text).replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    })[char]);
  }

  escapeRegExp(text = "") {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  handleKeydown(e) {
    if (this.searchModal.classList.contains("hidden")) return; // Prevent running when modal is closed
    if (this.resultItems.length === 0) return;

    if (e.key ==="ArrowDown") this.selectedIndex = Math.min(this.selectedIndex + 1, this.resultItems.length - 1);
    else if (e.key === "ArrowUp") this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
    else if (e.key === "Enter" && this.selectedIndex >= 0) this.openNotepad(this.resultItems[this.selectedIndex].dataset.id, this.query);
    else if (e.key === "Enter" && this.selectedIndex === -1) this.openNotepad(this.resultItems[0].dataset.id, this.query); // opens the first item by default
    
    this.displayResults(this.cache[`${this.query}-${this.page}`]);
  }

  displayResults(data) {
    const results = data.results;
    if(!results || results?.length === 0) {
      return;
    }

    let html = results
      .map((result, i) => 
        `<li class="${i === this.selectedIndex ? 'selected' : ''}" data-id="${this.escapeHtml(result.id)}">
            <div class="search-result-title">${this.highlightMatch(result.title)}</div>
            ${result.matchType === 'content' ? `<div class="search-result-snippet">${this.highlightMatch(result.snippet)}</div>` : ''}
         </li>`
      ).join("");

    this.searchResults.innerHTML = html;

    // Update resultItems after the DOM has been updated
    this.resultItems = this.searchResults.querySelectorAll("li");
    this.resultItems.forEach(item => {
      item.addEventListener("click", async () => {
          const id = item.getAttribute("data-id");
          await this.openNotepad(id, this.query);
        });
    });
  }
  
  clearResults() {
    this.searchResults.innerHTML = "";
    this.selectedIndex = -1;
    this.resultItems = this.searchResults.querySelectorAll("li");
  }

  async openNotepad(id, query = "") {
    await this.selectNotepad(id, query);
    this.closeModal();
  }

  openModal() {
    this.closeModals(); // close any open modals
    this.clearResults();
    this.openSearchBtn.classList.add('active');
    this.searchModal.classList.remove('hidden');
    this.searchBox.focus();
  }

  closeModal() {
    this.searchModal.classList.add('hidden');
    this.openSearchBtn.classList.remove('active');
    this.searchBox.value = "";
    this.clearResults();
  }

  addEventListeners() {
    this.openSearchBtn.addEventListener("click", this.openModal.bind(this));
    this.searchBox.addEventListener("input", this.debounce((e) => {
      if (!e.target.value) {
        this.searchResults.innerHTML = "";
        return;
      }

      this.search(e.target.value);
    }));
    
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape")
        this.closeModal();

      this.handleKeydown(e);
    });

    this.searchModal.addEventListener("click", (e) => {
      if (e.target.id === "search-modal") this.closeModal();
    })
  }
}
