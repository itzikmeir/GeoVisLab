import os

# --- בדיקת קבצים בתיקייה ---
current_folder = os.path.dirname(os.path.abspath(__file__))
print("קבצים שנמצאו בתיקייה הנוכחית:")
for f in os.listdir(current_folder):
    if f.endswith(".html"):
        print(f"'{f}'")
print("---------------------------")
# --- הגדרות ---

# 1. שמות קבצי המקור (התבניות) שנמצאים באותה תיקייה עם הסקריפט
templates = {
    'H': 'SCNֹֹ_001_H.html',  # שים לב: שיניתי מ-H ל-T
    'R': 'SCNֹֹ_001_R.html',
    'S': 'SCNֹֹ_001_S.html'
}

# 2. לאן לשמור את הקבצים? (נתיב יחסי מתיקיית ה-scripts לתיקיית ה-public)
# ה-../ אומר "צא תיקייה אחת אחורה" ואז כנס ל-public
output_dir = os.path.join("..", "public", "scenarios") 

# המחרוזת שיש להחליף
original_id_pattern = "SCNֹֹ_001"
original_id_clean = "SCN_001"

# --- ביצוע ---

# יצירת התיקייה אם אינה קיימת
if not os.path.exists(output_dir):
    os.makedirs(output_dir)
    print(f"Created directory: {output_dir}")

print(f"Generating 90 files into: {output_dir}...")

current_folder = os.path.dirname(os.path.abspath(__file__))

for i in range(1, 31):
    # יצירת מזהה תרחיש חדש (למשל SCN_001)
    scenario_id = f"SCN_{i:03d}" 
    
    for condition_suffix, template_filename in templates.items():
        new_filename = f"{scenario_id}_{condition_suffix}.html"
        output_path = os.path.join(output_dir, new_filename)
        template_path = os.path.join(current_folder, template_filename)
        
        try:
            with open(template_path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            # החלפת הטקסט
            new_content = content.replace(original_id_pattern, scenario_id)
            new_content = new_content.replace(original_id_clean, scenario_id)
            
            with open(output_path, 'w', encoding='utf-8') as f:
                f.write(new_content)
                
        except FileNotFoundError:
            print(f"Error: Template file '{template_filename}' not found inside 'scripts' folder.")
            break

print("Done! Check your public/scenarios folder.")