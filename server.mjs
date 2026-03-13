import express from 'express';
import axios from 'axios';
import { create, insert, search, remove } from '@orama/orama';
import chokidar from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

const app = express();
const td = new TurndownService();
const KNOWLEDGE_DIR = './knowledge';
const LLAMA_API = process.env.LLAMA_API || 'http://192.168.0.166:8080/v1';
const API_KEY = process.env.API_KEY || 'local-pi-key';

app.use(express.json());
app.use(express.static('public'));

// --- 1. THE DATABASE (Orama) ---
const db = await create({
    schema: { text: 'string', source: 'string' }
});

// --- 2. THE WATCHDOG (Ingestion & Pruning) ---
await fs.mkdir(KNOWLEDGE_DIR, { recursive: true });

chokidar.watch(KNOWLEDGE_DIR).on('all', async (event, filePath) => {
    const fileName = path.basename(filePath);
    if (path.extname(filePath) !== '.md') return;

    if (event === 'add' || event === 'change') {
        // Inside chokidar.watch...
        const content = await fs.readFile(filePath, 'utf-8');
        // Lower the threshold to 20 characters and trim better
        const chunks = content.split('\n').filter(c => c.trim().length > 20); 
        for (const chunk of chunks) {
            await insert(db, { text: chunk.trim(), source: fileName });
        }
        console.log(`✅ Indexed: ${fileName}`);
    } 
    else if (event === 'unlink') {
        // Find and purge deleted knowledge
        const allDocs = await search(db, { where: { source: fileName }, limit: 1000 });
        for (const hit of allDocs.hits) {
            await remove(db, hit.id);
        }
        console.log(`🗑️ Memory Purged: ${fileName}`);
    }
});

// --- 3. THE SCRAPER (Web Sense) ---
app.post('/api/learn-url', async (req, res) => {
    try {
        const { url } = req.body;
        const { data: html } = await axios.get(url);
        const $ = cheerio.load(html);
        $('script, style, nav, footer').remove();
        
        const markdown = td.turndown($('article').html() || $('body').html());
        const filename = `${Date.now()}.md`;
        await fs.writeFile(path.join(KNOWLEDGE_DIR, filename), `# Source: ${url}\n\n${markdown}`);
        
        res.json({ message: "Knowledge acquired." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- 4. KNOWLEDGE MANAGEMENT (The API) ---
app.get('/api/knowledge', async (req, res) => {
    try {
        const files = await fs.readdir(KNOWLEDGE_DIR);
        res.json({ files: files.filter(f => f.endsWith('.md')) });
    } catch (err) {
        res.status(500).json({ error: "Failed to list knowledge." });
    }
});

app.delete('/api/knowledge/:filename', async (req, res) => {
    try {
        await fs.unlink(path.join(KNOWLEDGE_DIR, req.params.filename)); 
        // The Watchdog 'unlink' event handles the DB purge automatically!
        res.json({ message: "Memory purged successfully." });
    } catch (err) {
        res.status(500).json({ error: "Failed to delete file." });
    }
});

// --- 5. THE RAG CHAT (Logic Engine) ---
app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    try {
        const sResult = await search(db, { 
            term: message, 
            limit: 5, // Increased limit for better coverage
            tolerance: 2 
        });
        
        const context = sResult.hits.map(h => h.document.text).join('\n---\n');
        
        // Debugging: See what is actually being found in terminal
        console.log(`🔍 Search for "${message}" found ${sResult.count} chunks.`);

        const systemContent = `You are a local AI. Answer strictly using the context provided below. 
If the answer is not in the context, say "RECOURSE".

CONTEXT:
${context || "No context found in memory."}`;

        const aiRes = await axios.post(`${LLAMA_API}/chat/completions`, {
            model: "qwen", // Ensure this matches your llama-server config
            messages: [
                { role: "system", content: systemContent },
                { role: "user", content: message }
            ],
            temperature: 0.0, // Iron discipline: no creativity
            max_tokens: 150
        }, { headers: { 'Authorization': `Bearer ${API_KEY}` } });

        res.json({ answer: aiRes.data.choices[0].message.content, context });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Brain connection lost." });
    }
});

app.listen(3000, () => console.log('🚀 kheAI running on port 3000'));