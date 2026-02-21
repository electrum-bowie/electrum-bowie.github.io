AFRAME.registerComponent("update-error-display", {
    tick: function () {
        // Replace this with your actual method of getting the most recent error message
        const recentErrorMessage = getMostRecentErrorMessage();

        if (recentErrorMessage) {
            updateErrorMessage(recentErrorMessage);
        }
    },
});

// You should have a function to get the most recent error message
function getMostRecentErrorMessage() {
    // Replace this with your logic to get the most recent error message
    return "Sample Error Message";
}
function updateErrorMessage(message) {
    const errorDisplay = document.querySelector("#errorDisplay");
    errorDisplay.setAttribute("text", { value: message });
}
