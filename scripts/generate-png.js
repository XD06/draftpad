const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Sizes to generate
const sizes = [16, 32, 64, 128, 256];

async function convertToPng() {
    const svgBuffer = fs.readFileSync(path.join(__dirname, '../public/favicon.svg'));
    
    for (const size of sizes) {
        await sharp(svgBuffer)
            .resize(size, size)
            .png()
            .toFile(path.join(__dirname, `../public/favicon-${size}.png`));
        
        console.log(`Generated ${size}x${size} PNG`);
    }
}

convertToPng().catch(console.error); 