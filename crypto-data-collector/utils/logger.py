import logging
import sys

def setup_logger(name="CryptoCollector"):
    logger = logging.getLogger(name)
    
    # Prevent adding handlers multiple times if instantiated repeatedly
    if not logger.handlers:
        logger.setLevel(logging.INFO)
        
        formatter = logging.Formatter(
            '%(asctime)s | %(levelname)-8s | %(name)s | %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        
        # Console Handler
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setFormatter(formatter)
        logger.addHandler(console_handler)
        
        # File Handler
        file_handler = logging.FileHandler("debug.log", mode='a')
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)
        
    return logger

# Global logger instance
log = setup_logger()
