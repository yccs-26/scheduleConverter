chrome.action.onClicked.addListener( () => {
    chrome.windows.create({
        url: chrome.runtime.getURL("popup.html")
    });
});