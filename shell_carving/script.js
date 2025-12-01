// 全局变量
let currentQuestion = 0;
let answers = {};
let currentPersonality = null;

// 页面导航函数
function showPage(pageId) {
    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });
    document.getElementById(pageId).classList.add('active');
    window.scrollTo(0, 0);
}

// 去首页
function goToHome() {
    currentQuestion = 0;
    answers = {};
    currentPersonality = null;
    showPage('homePage');
}

// 去测试页面
function goToTest() {
    currentQuestion = 0;
    answers = {};
    showPage('testPage');
    loadQuestion(0);
}

// 去结果页面
function goToResult() {
    showPage('resultPage');
}

// 去详情页面
function goToDetail(dimensionIndex) {
    if (currentPersonality) {
        const dimension = currentPersonality.dimensions[dimensionIndex];
        displayDetail(dimension);
        showPage('detailPage');
    }
}

// 加载问题
function loadQuestion(index) {
    if (index < 0 || index >= questions.length) return;

    currentQuestion = index;
    const question = questions[index];
    const container = document.getElementById('questionContainer');

    // 构建问题HTML
    let html = `
        <div class="question-number">${index + 1}</div>
        <span class="question-text">${question.text}</span>
        <div style="margin-top: 20px;">
    `;

    question.options.forEach(option => {
        const isSelected = answers[`q${index + 1}`] === option.value;
        const selectedClass = isSelected ? 'selected' : '';
        html += `
            <div class="option ${selectedClass}" onclick="selectOption(this, ${index}, '${option.value}')">
                <input type="radio" name="q${index + 1}" value="${option.value}" ${isSelected ? 'checked' : ''}>
                <label>${option.text}</label>
            </div>
        `;
    });

    html += '</div>';
    container.innerHTML = html;

    // 更新按钮状态
    updateButtons();

    // 更新进度条
    updateProgress();
}

// 选择选项
function selectOption(element, questionIndex, value) {
    const options = element.parentElement.querySelectorAll('.option');
    options.forEach(opt => opt.classList.remove('selected'));
    element.classList.add('selected');
    
    answers[`q${questionIndex + 1}`] = value;
    
    // 自动进入下一题
    setTimeout(() => {
        if (questionIndex < questions.length - 1) {
            nextQuestion();
        }
    }, 300);
}

// 下一题
function nextQuestion() {
    if (currentQuestion < questions.length - 1) {
        loadQuestion(currentQuestion + 1);
    }
}

// 上一题
function previousQuestion() {
    if (currentQuestion > 0) {
        loadQuestion(currentQuestion - 1);
    }
}

// 更新按钮状态
function updateButtons() {
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');

    if (currentQuestion === 0) {
        prevBtn.style.display = 'none';
    } else {
        prevBtn.style.display = 'inline-block';
    }

    if (currentQuestion === questions.length - 1) {
        nextBtn.innerHTML = '<i class="fas fa-check"></i> 查看结果';
        nextBtn.onclick = submitTest;
    } else {
        nextBtn.innerHTML = '<i class="fas fa-arrow-right"></i> 下一题';
        nextBtn.onclick = nextQuestion;
    }
}

// 更新进度条
function updateProgress() {
    const answered = Object.keys(answers).length;
    const total = questions.length;
    const percentage = ((currentQuestion + 1) / total) * 100;
    document.getElementById('progressBar').style.width = percentage + '%';
    document.getElementById('currentQuestion').textContent = currentQuestion + 1;
}

// 提交测试
function submitTest() {
    // 检查是否所有问题都已回答
    if (Object.keys(answers).length < questions.length) {
        alert('请完成所有问题！');
        return;
    }

    // 计算人格类型
    const personalityCode = 
        answers.q1 + 
        answers.q2 + 
        answers.q3 + 
        answers.q4;

    currentPersonality = personalityTypes[personalityCode];

    if (currentPersonality) {
        displayResult();
        goToResult();
    }
}

// 显示结果
function displayResult() {
    document.getElementById('resultTitle').textContent = currentPersonality.name;
    document.getElementById('resultSubtitle').textContent = currentPersonality.subtitle;
    document.getElementById('resultDescription').textContent = currentPersonality.description;

    // 显示标签
    const tagsHtml = currentPersonality.tags.map(tag => `<span class="tag">${tag}</span>`).join('');
    document.getElementById('dimensionTags').innerHTML = tagsHtml;

    // 显示维度详情（可点击）
    const dimensionsHtml = currentPersonality.dimensions.map((dim, index) => `
        <div class="dimension-item" onclick="goToDetail(${index})">
            <h4>${dim.title}</h4>
            <p><strong>${dim.value}</strong></p>
            <p style="font-size: 0.9rem; margin-top: 8px; color: #999;">点击查看详情 →</p>
        </div>
    `).join('');
    document.getElementById('dimensionsDetail').innerHTML = dimensionsHtml;
}

// 显示详情
function displayDetail(dimension) {
    const detailContent = document.getElementById('detailContent');
    
    const html = `
        <div class="detail-header">
            <div class="detail-title">${dimension.title}</div>
            <div class="detail-subtitle">${dimension.value}</div>
        </div>
        <div class="detail-content-box">
            <h3>人格特质</h3>
            <p>${dimension.desc}</p>
        </div>
    `;

    detailContent.innerHTML = html;
}

// 分享结果
function shareResult() {
    const title = document.getElementById('resultTitle').textContent;
    const subtitle = document.getElementById('resultSubtitle').textContent;
    const text = `我在"贝雕人格测试"中的人格类型是：${title}（${subtitle}）。你也来测试一下吧！`;
    
    if (navigator.share) {
        navigator.share({
            title: '贝雕人格测试',
            text: text,
            url: window.location.href
        });
    } else {
        // 复制到剪贴板
        navigator.clipboard.writeText(text).then(() => {
            alert('已复制到剪贴板！\n' + text);
        }).catch(() => {
            alert(text);
        });
    }
}

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    // 设置总题数
    document.getElementById('totalQuestions').textContent = questions.length;
});

