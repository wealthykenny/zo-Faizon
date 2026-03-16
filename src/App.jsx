import { useMemo, useState } from 'react';

const MODES = [
  { id: 'realistic', label: 'FAIZON REALISTIC' },
  { id: 'aesthetics', label: 'FAIZON AESTHETICS' }
];

const RATIOS = ['1:1', '4:5', '3:2', '16:9', '9:16'];

export default function App() {
  const [mode, setMode] = useState('realistic');
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [editImage, setEditImage] = useState(null);
  const [preview, setPreview] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const modeCopy = useMemo(() => (
    mode === 'realistic'
      ? 'Photorealistic text-to-image and ultra-detailed edits.'
      : 'Stylized aesthetics: iPhone 4S, 80s, surreal, cottagecore, duotone, blur.'
  ), [mode]);

  async function onFileChange(event) {
    const file = event.target.files?.[0];
    if (!file) {
      setEditImage(null);
      setPreview('');
      return;
    }

    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);

    setEditImage({
      name: file.name,
      mimeType: file.type || 'image/png',
      data: base64
    });
    setPreview(URL.createObjectURL(file));
  }

  async function handleGenerate() {
    setLoading(true);
    setError('');
    setResult(null);

    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, prompt, negativePrompt, aspectRatio, editImage })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Generation failed');
      setResult(data);
    } catch (err) {
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <div className="brand-mark">⬢</div>
        <div>
          <h1>FAZION</h1>
          <p>BUILT BY TEKTREY</p>
        </div>
      </header>

      <main className="panel">
        <section>
          <h2>ENGINE MODE</h2>
          <div className="mode-switch">
            {MODES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={mode === item.id ? 'active' : ''}
                onClick={() => setMode(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="subtle">{modeCopy}</p>
        </section>

        <section>
          <h2>NEURAL PROMPT</h2>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe your vision in extraordinary detail..."
          />
        </section>

        <section>
          <h2>NEGATIVE PROMPT</h2>
          <textarea
            value={negativePrompt}
            onChange={(e) => setNegativePrompt(e.target.value)}
            placeholder="Things to avoid..."
          />
        </section>

        <section className="grid-two">
          <div>
            <h2>ASPECT RATIO</h2>
            <select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
              {RATIOS.map((ratio) => (
                <option key={ratio} value={ratio}>{ratio}</option>
              ))}
            </select>
          </div>
          <div>
            <h2>MULTIMODAL EDIT</h2>
            <label className="upload-box">
              <input type="file" accept="image/*" onChange={onFileChange} />
              <span>{editImage ? editImage.name : 'Upload a source image for edits'}</span>
            </label>
          </div>
        </section>

        {preview ? <img className="preview-image" src={preview} alt="Edit source preview" /> : null}

        <button type="button" className="generate-btn" disabled={loading || !prompt.trim()} onClick={handleGenerate}>
          {loading ? 'GENERATING...' : 'GENERATE'}
        </button>

        {error ? <div className="error-box">{error}</div> : null}

        {result ? (
          <>
            <section>
              <h2>RECONSTRUCTED PROMPT</h2>
              <div className="prompt-box">{result.productionPrompt}</div>
            </section>
            <section>
              <h2>RESULT</h2>
              <img className="result-image" src={result.imageUrl || result.image} alt="Fazion result" />
              {result.imageUrl ? <p className="subtle">Stored on S3 and expected to expire after 2 days if your bucket lifecycle rule is enabled.</p> : null}
            </section>
          </>
        ) : null}
      </main>

      <footer>Copyright Fazion</footer>
    </div>
  );
}
