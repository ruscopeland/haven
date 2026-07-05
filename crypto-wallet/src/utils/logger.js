let logCallback = null;

export function registerLogCallback(cb) {
  logCallback = cb;
}

export function log(message, type = 'info') {
  if (logCallback) {
    // Defer the callback to ensure state updates happen outside React's render phase
    setTimeout(() => {
      if (logCallback) {
        logCallback(message, type);
      }
    }, 0);
  }
  
  const timestamp = new Date().toLocaleTimeString();
  const formattedMsg = `[${timestamp}] [${type.toUpperCase()}] ${message}`;
  
  if (type === 'error') {
    console.error(formattedMsg);
  } else if (type === 'warning') {
    console.warn(formattedMsg);
  } else {
    console.log(formattedMsg);
  }
}
