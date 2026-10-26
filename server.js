const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure upload directory exists
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Storage engine for uploading HTML/TXT games
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        // Sanitize file name and preserve .html extension
        const cleanName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        const finalName = cleanName.endsWith('.html') || cleanName.endsWith('.txt')
            ? cleanName.replace(/\.(txt|html)$/, '.html')
            : `${cleanName}.html`;
        cb(null, `${Date.now()}_${finalName}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB max file size
});

// Serve main hub static files
app.use(express.static(path.join(__dirname, 'public')));

// Upload route
app.post('/upload', upload.single('gameFile'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
    }
    res.json({
        success: true,
        gameUrl: `/play/${req.file.filename}`,
        title: req.file.originalname
    });
});

// List uploaded games
app.get('/api/games', (req, res) => {
    fs.readdir(UPLOADS_DIR, (err, files) => {
        if (err) return res.status(500).json({ error: 'Failed to read directory' });
        const htmlFiles = files.filter(f => f.endsWith('.html')).map(f => ({
            id: f,
            name: f.substring(f.indexOf('_') + 1).replace('.html', ''),
            url: `/play/${f}`
        }));
        res.json(htmlFiles);
    });
});

// Serve individual game files with unrestricted security headers for pointer-lock & audio
app.use('/play', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Feature-Policy', "microphone '*'; camera '*'; display-capture '*'; autoplay '*'; pointer-lock '*'");
    next();
}, express.static(UPLOADS_DIR));

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
