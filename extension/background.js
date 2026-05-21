// Screenshots live here — in service worker memory.
// Survives page navigations, gone when the browser closes.
const screenshots = {};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'captureTab') {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }, (dataUrl) => {
      sendResponse({ dataUrl: dataUrl || null });
    });
    return true;
  }

  if (msg.action === 'saveScreenshot') {
    screenshots[msg.id] = msg.dataUrl;
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'getScreenshots') {
    sendResponse({ screenshots });
    return true;
  }

  if (msg.action === 'removeScreenshot') {
    delete screenshots[msg.id];
    sendResponse({ ok: true });
    return true;
  }
});
