const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('URL missing');

    try {
        const response = await axios.get(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            responseType: 'text'
        });
        res.removeHeader('X-Frame-Options');
        res.removeHeader('Content-Security-Policy');
        res.set('Access-Control-Allow-Origin', '*');
        res.send(response.data);
    } catch (error) {
        res.status(500).send(`Error: ${error.message}`);
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
