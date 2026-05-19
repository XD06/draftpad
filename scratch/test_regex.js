const html = `
<span data-note="测试" style="text-decoration:underline wavy #e74c3c;text-decoration-thickness:2.5px;">OpenHuman 的定位是"你的私人 AI 超级智能"，不仅是一个聊天助手，而是全天候陪伴式的 Agent 系统：</span><sub data-note-label style="color:#e74c3c;font-size:0.65em;margin-left:2px;">（测试）</sub>

<span data-draw style="text-decoration:underline blue;text-decoration-thickness:2px;">OpenHuman 是当前 AI Agent 赛道中最接近"个人 AI 管家"愿景的项目。三个核心差异化优势：</span>
`;
let res = html.replace(/(<span\s+[^>]*data-note(?:="[^"]*")?[^>]*>.*?<\/span>\s*<sub\s+[^>]*data-note-label[^>]*>.*?<\/sub>)/gs, '<div>$1</div>');
res = res.replace(/(<span\s+[^>]*data-draw(?:="[^"]*")?[^>]*>.*?<\/span>)/gs, '<div>$1</div>');
console.log(res);
