export default class SettingsManager {
  constructor(storageManager, applySettings) {
    this.storageManager = storageManager;
    this.SETTINGS_KEY = 'dumbpad_settings';
    this.applySettings = applySettings
    this.settingsInputAutoSaveStatusInterval = document.getElementById('autosave-status-interval-input');
    this.settingsDisablePrintExpand = document.getElementById('settings-disable-print-expand');
  }
  
  defaultSettings() {
    return { // Add additional default settings in here:
      saveStatusMessageInterval: 500,
      disablePrintExpand: false,
    }
  }

  getSettings() {
    try {
      let currentSettings = this.storageManager.load(this.SETTINGS_KEY);
      if (!currentSettings) currentSettings = this.defaultSettings();
      // console.log("Current Settings:", currentSettings);
      return currentSettings;
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  saveSettings(reset) {
    try {
      const settingsToSave = reset ? this.defaultSettings() : this.getInputValues();
      this.storageManager.save(this.SETTINGS_KEY, settingsToSave);
      // console.log("Saved new settings:", newSettings);
      this.applySettings(settingsToSave);
      return settingsToSave;
    }
    catch (err) {
      console.error(err);
    }
  }

  loadSettings(reset) {
    try {
      const appSettings = this.defaultSettings();
      let currentSettings = this.getSettings();
  
      if (reset || !currentSettings) currentSettings = this.saveSettings(true);
  
      appSettings.saveStatusMessageInterval = currentSettings.saveStatusMessageInterval;
      if (this.settingsInputAutoSaveStatusInterval) {
        this.settingsInputAutoSaveStatusInterval.value = currentSettings.saveStatusMessageInterval;
      }

      appSettings.disablePrintExpand = currentSettings.disablePrintExpand;
      if (this.settingsDisablePrintExpand) {
        this.settingsDisablePrintExpand.checked = currentSettings.disablePrintExpand;
      }
      
      return currentSettings;
    }
    catch (err) {
      console.error(err);
      return this.defaultSettings();
    }
  }

  getInputValues() {
    const appSettings = this.defaultSettings();

    if (this.settingsInputAutoSaveStatusInterval) {
      let newInterval = parseInt(this.settingsInputAutoSaveStatusInterval.value.trim());
      if (isNaN(newInterval) || newInterval <= 0) newInterval = null;
      appSettings.saveStatusMessageInterval = newInterval;
    }

    if (this.settingsDisablePrintExpand) {
      appSettings.disablePrintExpand = this.settingsDisablePrintExpand.checked;
    }
    
    return appSettings;
  }
}
