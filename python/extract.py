import json
import re

log_path = r"C:\Users\sahil\.gemini\antigravity\brain\e33676d8-931a-4e47-a9a9-9410bccc30af\.system_generated\logs\transcript_full.jsonl"
out_path = r"c:\python\progress tracker\defaultData.js"

longest_data = ""

with open(log_path, 'r', encoding='utf-8') as f:
    for line in f:
        if '"const syllabusData =' in line:
            # We found a line. Let's extract the syllabusData array.
            data = json.loads(line)
            # Depending on structure, content might be nested
            content = str(data)
            match = re.search(r'(const syllabusData = \[.*?\];)', content, flags=re.DOTALL)
            if match:
                extracted = match.group(1)
                if len(extracted) > len(longest_data):
                    longest_data = extracted

if longest_data:
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write("export " + longest_data)
    print("Data extracted successfully!")
else:
    print("Could not find data.")
